// Servidor de notificações do auto clicker.
//
// O clicker (PC do jogo) envia eventos via HTTP POST. Os dispositivos
// (navegador, app) recebem os eventos em tempo real via SSE.
//
//   POST /api/eventos           clicker -> servidor   (header Authorization: Bearer TOKEN)
//   GET  /api/eventos/stream    servidor -> dispositivos (SSE, ?token=TOKEN)
//   GET  /api/status            estado atual do clicker (?token=TOKEN)
//   GET  /                      página de teste no navegador

const express = require("express");
const path = require("path");

const PORTA = Number(process.env.PORT) || 3000;
const TOKEN = process.env.TOKEN;
const HISTORICO_MAX = 50;
const OFFLINE_APOS_MS = 30_000; // sem heartbeat por esse tempo => clicker offline
const KEEPALIVE_MS = 15_000;    // comentário SSE para proxies não fecharem a conexão

if (!TOKEN) {
  console.error("Defina a variável de ambiente TOKEN (veja .env.example).");
  process.exit(1);
}

const TIPOS = new Set(["iniciado", "anomalia", "pausado", "retomado", "encerrado", "heartbeat", "teste"]);

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

let proximoId = 1;
const historico = [];         // últimos eventos, para quem reconectar
const clientes = new Set();   // respostas SSE abertas
const estado = { online: false, clicando: false, ultimoContato: null };

function autorizado(req) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
  return token === TOKEN;
}

function exigirToken(req, res, next) {
  if (!autorizado(req)) return res.status(401).json({ erro: "token inválido" });
  next();
}

function enviar(res, evento) {
  res.write(`id: ${evento.id}\nevent: ${evento.tipo}\ndata: ${JSON.stringify(evento)}\n\n`);
}

function publicar(tipo, mensagem, extra = {}) {
  const evento = { id: proximoId++, tipo, mensagem, data: new Date().toISOString(), ...extra };
  if (tipo !== "heartbeat") {
    historico.push(evento);
    if (historico.length > HISTORICO_MAX) historico.shift();
    console.log(`[${evento.data}] ${tipo}: ${mensagem}`);
  }
  for (const res of clientes) enviar(res, evento);
  return evento;
}

app.post("/api/eventos", exigirToken, (req, res) => {
  const { tipo, mensagem = "", clicando } = req.body || {};
  if (!TIPOS.has(tipo)) return res.status(400).json({ erro: `tipo inválido: ${tipo}` });

  const voltouOnline = !estado.online;
  estado.online = tipo !== "encerrado";
  estado.ultimoContato = Date.now();
  if (typeof clicando === "boolean") estado.clicando = clicando;

  if (voltouOnline && tipo === "heartbeat") publicar("online", "Clicker conectado");
  const evento = publicar(tipo, String(mensagem).slice(0, 500), { clicando: estado.clicando });
  res.status(201).json(evento);
});

app.get("/api/eventos/stream", exigirToken, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // desliga buffer do nginx
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  // Reenvia o que a conexão perdeu enquanto esteve fora
  const ultimoId = Number(req.get("last-event-id") || req.query.desde || 0);
  for (const evento of historico) if (evento.id > ultimoId) enviar(res, { ...evento, replay: true });
  res.write(`event: status\ndata: ${JSON.stringify(estado)}\n\n`);

  clientes.add(res);
  req.on("close", () => clientes.delete(res));
});

app.get("/api/status", exigirToken, (req, res) => {
  res.json({ ...estado, dispositivos: clientes.size, historico });
});

setInterval(() => {
  for (const res of clientes) res.write(": keepalive\n\n");
}, KEEPALIVE_MS);

setInterval(() => {
  if (estado.online && Date.now() - estado.ultimoContato > OFFLINE_APOS_MS) {
    estado.online = false;
    estado.clicando = false;
    publicar("offline", "Clicker parou de responder (PC desligado, sem internet ou programa fechado)");
  }
}, 5_000);

app.listen(PORTA, () => console.log(`Servidor ouvindo na porta ${PORTA}`));
