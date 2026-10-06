// Servidor de notificações do audio-watch-clicker (multiusuário).
//
// Cada usuário faz login (JWT). Os clickers dele enviam eventos e só os
// dispositivos dele (web, mobile) recebem, em tempo real, via SSE.
//
//   POST /api/auth/registrar     cria conta                 { email, senha, dispositivo? }
//   POST /api/auth/login         entra                      { email, senha, dispositivo? }
//   POST /api/auth/refresh       renova os tokens           { refreshToken }
//   POST /api/auth/logout        encerra a sessão           { refreshToken }
//   GET  /api/me                 dados do usuário logado
//   POST /api/eventos            clicker -> servidor        { tipo, mensagem?, clicando?, cliente? }
//   GET  /api/eventos/stream     servidor -> dispositivos   (SSE)
//   GET  /api/status             estado dos clickers + histórico
//
// Todas as rotas fora de /api/auth exigem "Authorization: Bearer <accessToken>".

const express = require("express");
const path = require("path");
const { sql, linhaParaEvento } = require("./db");
const auth = require("./auth");

const PORTA = Number(process.env.PORT) || 3000;
const REGISTRO_ABERTO = process.env.REGISTRO_ABERTO !== "false";
const OFFLINE_APOS_MS = 30_000; // clicker sem heartbeat por esse tempo => offline
const KEEPALIVE_MS = 15_000;    // comentário SSE para proxies não fecharem a conexão
const REPLAY_PADRAO = 20;       // eventos reenviados a quem conecta sem Last-Event-ID

const TIPOS_CLIENTE = new Set(["iniciado", "anomalia", "pausado", "retomado", "encerrado", "heartbeat", "teste"]);
const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY); // atrás do nginx: "1"
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------- estado em memória
// usuarioId -> { conexoes: Set<res>, clickers: Map<cliente, { online, clicando, ultimoContato }> }
const usuarios = new Map();

function estadoDe(usuarioId) {
  let estado = usuarios.get(usuarioId);
  if (!estado) {
    estado = { conexoes: new Set(), clickers: new Map() };
    usuarios.set(usuarioId, estado);
  }
  return estado;
}

function resumoClickers(estado) {
  return [...estado.clickers].map(([cliente, c]) => ({ cliente, ...c }));
}

function enviarSSE(res, evento, nome = evento.tipo) {
  const id = evento.id ? `id: ${evento.id}\n` : "";
  res.write(`${id}event: ${nome}\ndata: ${JSON.stringify(evento)}\n\n`);
}

/** Publica um evento para todos os dispositivos conectados do usuário. */
function publicar(usuarioId, tipo, mensagem, cliente, clicando) {
  const data = new Date().toISOString();
  let evento = { tipo, mensagem, cliente, clicando, data };

  if (tipo !== "heartbeat") {
    const r = sql.inserirEvento.run(usuarioId, tipo, mensagem, cliente, clicando === undefined ? null : Number(clicando), data);
    evento = { id: Number(r.lastInsertRowid), ...evento };
    sql.podarEventos.run(usuarioId, usuarioId);
    console.log(`[${data}] usuário ${usuarioId} | ${cliente} | ${tipo}: ${mensagem}`);
  }
  for (const res of estadoDe(usuarioId).conexoes) enviarSSE(res, evento);
  return evento;
}

// ---------------------------------------------------------------- autenticação
// Express 4 não captura erros de rotas async: repassa para o tratador de erros
const rota = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const limitarAuth = auth.limitarTentativas({ max: 10, janelaMs: 15 * 60_000 });

function validarCredenciais(req, res) {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const senha = String(req.body?.senha || "");
  if (!EMAIL_VALIDO.test(email) || email.length > 254) {
    res.status(400).json({ erro: "e-mail inválido" });
    return null;
  }
  if (senha.length < 8 || senha.length > 200) {
    res.status(400).json({ erro: "a senha precisa ter entre 8 e 200 caracteres" });
    return null;
  }
  return { email, senha, dispositivo: req.body?.dispositivo };
}

app.post("/api/auth/registrar", limitarAuth, rota(async (req, res) => {
  if (!REGISTRO_ABERTO) return res.status(403).json({ erro: "registro desativado neste servidor" });
  const dados = validarCredenciais(req, res);
  if (!dados) return;
  if (sql.usuarioPorEmail.get(dados.email)) return res.status(409).json({ erro: "e-mail já cadastrado" });

  const senhaHash = await auth.hashSenha(dados.senha);
  const r = sql.criarUsuario.run(dados.email, senhaHash, new Date().toISOString());
  const usuario = { id: Number(r.lastInsertRowid), email: dados.email };
  res.status(201).json(auth.emitirTokens(usuario, dados.dispositivo));
}));

app.post("/api/auth/login", limitarAuth, rota(async (req, res) => {
  const dados = validarCredenciais(req, res);
  if (!dados) return;
  const usuario = sql.usuarioPorEmail.get(dados.email);
  if (!(await auth.verificarSenhaOuFalso(dados.senha, usuario))) {
    return res.status(401).json({ erro: "e-mail ou senha incorretos" });
  }
  res.json(auth.emitirTokens(usuario, dados.dispositivo));
}));

app.post("/api/auth/refresh", (req, res) => {
  const tokens = auth.renovar(req.body?.refreshToken);
  if (!tokens) return res.status(401).json({ erro: "sessão expirada, faça login novamente" });
  res.json(tokens);
});

app.post("/api/auth/logout", (req, res) => {
  auth.revogar(req.body?.refreshToken);
  res.status(204).end();
});

app.get("/api/me", auth.exigirAuth, (req, res) => {
  const usuario = sql.usuarioPorId.get(req.usuario.id);
  if (!usuario) return res.status(404).json({ erro: "usuário não existe mais" });
  res.json({ id: Number(usuario.id), email: usuario.email, criadoEm: usuario.criado_em });
});

// ---------------------------------------------------------------- eventos
app.post("/api/eventos", auth.exigirAuth, (req, res) => {
  const { tipo, mensagem = "", clicando } = req.body || {};
  if (!TIPOS_CLIENTE.has(tipo)) return res.status(400).json({ erro: `tipo inválido: ${tipo}` });
  const cliente = String(req.body.cliente || "pc").slice(0, 64);

  // Teste não representa um clicker de verdade: não entra no controle de online/offline
  if (tipo === "teste") {
    return res.status(201).json(publicar(req.usuario.id, tipo, String(mensagem).slice(0, 500), cliente));
  }

  const estado = estadoDe(req.usuario.id);
  const anterior = estado.clickers.get(cliente);
  const clicker = anterior || { online: false, clicando: false, ultimoContato: 0 };
  const voltouOnline = !clicker.online && tipo !== "encerrado";

  clicker.online = tipo !== "encerrado";
  clicker.ultimoContato = Date.now();
  if (typeof clicando === "boolean") clicker.clicando = clicando;
  estado.clickers.set(cliente, clicker);

  if (voltouOnline && tipo === "heartbeat") publicar(req.usuario.id, "online", "Clicker conectado", cliente);
  const evento = publicar(req.usuario.id, tipo, String(mensagem).slice(0, 500), cliente, clicker.clicando);
  res.status(201).json(evento);
});

app.get("/api/eventos/stream", auth.exigirAuth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // desliga buffer do nginx
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  // Reenvia o que a conexão perdeu (ou os últimos eventos, na primeira conexão)
  const ultimoId = Number(req.get("last-event-id") || req.query.desde);
  const linhas = ultimoId > 0
    ? sql.eventosDesde.all(req.usuario.id, ultimoId, 100)
    : sql.ultimosEventos.all(req.usuario.id, REPLAY_PADRAO);
  for (const linha of linhas) enviarSSE(res, { ...linhaParaEvento(linha), replay: true });

  const estado = estadoDe(req.usuario.id);
  enviarSSE(res, { clickers: resumoClickers(estado) }, "status");

  estado.conexoes.add(res);
  req.on("close", () => estado.conexoes.delete(res));
});

app.get("/api/status", auth.exigirAuth, (req, res) => {
  const estado = estadoDe(req.usuario.id);
  res.json({
    clickers: resumoClickers(estado),
    dispositivos: estado.conexoes.size,
    historico: sql.ultimosEventos.all(req.usuario.id, 50).map(linhaParaEvento),
  });
});

app.use((erro, req, res, next) => {
  console.error(erro);
  if (res.headersSent) return next(erro);
  res.status(500).json({ erro: "erro interno" });
});

// ---------------------------------------------------------------- tarefas periódicas
setInterval(() => {
  for (const estado of usuarios.values()) for (const res of estado.conexoes) res.write(": keepalive\n\n");
}, KEEPALIVE_MS);

setInterval(() => {
  const agora = Date.now();
  for (const [usuarioId, estado] of usuarios) {
    for (const [cliente, c] of estado.clickers) {
      if (c.online && agora - c.ultimoContato > OFFLINE_APOS_MS) {
        c.online = false;
        c.clicando = false;
        publicar(usuarioId, "offline",
          "Clicker parou de responder (PC desligado, sem internet ou programa fechado)", cliente, false);
      }
    }
  }
}, 5_000);

app.listen(PORTA, () => {
  console.log(`Servidor ouvindo na porta ${PORTA} | registro ${REGISTRO_ABERTO ? "aberto" : "fechado"}`);
});
