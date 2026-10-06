// Autenticação: senha com scrypt, access token JWT curto e refresh token rotativo.
const crypto = require("crypto");
const { promisify } = require("util");
const jwt = require("jsonwebtoken");
const { sql } = require("./db");

const scrypt = promisify(crypto.scrypt);

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_EXPIRA_S = 15 * 60;              // 15 minutos
const REFRESH_EXPIRA_MS = 30 * 24 * 3600_000; // 30 dias

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("Defina JWT_SECRET com pelo menos 32 caracteres (veja .env.example).");
  process.exit(1);
}

async function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = await scrypt(senha, sal, 64);
  return `scrypt$${sal.toString("base64")}$${hash.toString("base64")}`;
}

async function verificarSenha(senha, armazenado) {
  const [, sal, hash] = armazenado.split("$");
  const esperado = Buffer.from(hash, "base64");
  const calculado = await scrypt(senha, Buffer.from(sal, "base64"), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado);
}

// Hash fixo para comparar quando o e-mail não existe (resposta leva o mesmo tempo)
let hashFalso = null;
async function verificarSenhaOuFalso(senha, usuario) {
  hashFalso ??= await hashSenha("senha-inexistente");
  const ok = await verificarSenha(senha, usuario ? usuario.senha_hash : hashFalso);
  return Boolean(usuario) && ok;
}

const sha256 = (texto) => crypto.createHash("sha256").update(texto).digest("hex");

function emitirTokens(usuario, dispositivo) {
  const accessToken = jwt.sign({ sub: String(usuario.id), email: usuario.email }, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: ACCESS_EXPIRA_S,
  });
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  sql.salvarRefresh.run(
    usuario.id,
    sha256(refreshToken),
    String(dispositivo || "desconhecido").slice(0, 100),
    Date.now() + REFRESH_EXPIRA_MS,
    new Date().toISOString()
  );
  return { accessToken, refreshToken, expiraEm: ACCESS_EXPIRA_S, usuario: { id: usuario.id, email: usuario.email } };
}

/** Troca um refresh token por um par novo. O antigo deixa de valer (rotação). */
function renovar(refreshToken) {
  const linha = sql.refreshPorHash.get(sha256(String(refreshToken || "")));
  if (!linha) return null;
  sql.apagarRefresh.run(linha.id);
  if (linha.expira_em < Date.now()) return null;
  const usuario = sql.usuarioPorId.get(linha.usuario_id);
  return usuario ? emitirTokens(usuario, linha.dispositivo) : null;
}

function revogar(refreshToken) {
  const linha = sql.refreshPorHash.get(sha256(String(refreshToken || "")));
  if (linha) sql.apagarRefresh.run(linha.id);
}

/** Middleware: exige "Authorization: Bearer <access token>". */
function exigirAuth(req, res, next) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ erro: "não autenticado" });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ["HS256"] });
    req.usuario = { id: Number(payload.sub), email: payload.email };
    next();
  } catch (erro) {
    const expirado = erro.name === "TokenExpiredError";
    res.status(401).json({ erro: expirado ? "token expirado" : "token inválido" });
  }
}

/** Limita tentativas por IP (login/registro) para dificultar força bruta. */
function limitarTentativas({ max, janelaMs }) {
  const tentativas = new Map();
  setInterval(() => {
    const agora = Date.now();
    for (const [ip, t] of tentativas) if (t.reinicia < agora) tentativas.delete(ip);
  }, janelaMs).unref();

  return (req, res, next) => {
    const agora = Date.now();
    const t = tentativas.get(req.ip);
    if (!t || t.reinicia < agora) {
      tentativas.set(req.ip, { n: 1, reinicia: agora + janelaMs });
      return next();
    }
    if (++t.n > max) {
      res.set("Retry-After", String(Math.ceil((t.reinicia - agora) / 1000)));
      return res.status(429).json({ erro: "muitas tentativas, tente mais tarde" });
    }
    next();
  };
}

setInterval(() => sql.apagarRefreshExpirados.run(Date.now()), 3600_000).unref();

module.exports = {
  hashSenha,
  verificarSenhaOuFalso,
  emitirTokens,
  renovar,
  revogar,
  exigirAuth,
  limitarTentativas,
};
