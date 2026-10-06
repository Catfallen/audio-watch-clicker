// Banco SQLite embutido no Node (node:sqlite), sem dependência nativa.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const EVENTOS_POR_USUARIO = 200; // histórico guardado por usuário

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "dados.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS usuarios (
    id          INTEGER PRIMARY KEY,
    email       TEXT    NOT NULL UNIQUE,
    senha_hash  TEXT    NOT NULL,
    criado_em   TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id           INTEGER PRIMARY KEY,
    usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL UNIQUE,
    dispositivo  TEXT,
    expira_em    INTEGER NOT NULL,
    criado_em    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eventos (
    id          INTEGER PRIMARY KEY,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo        TEXT    NOT NULL,
    mensagem    TEXT,
    cliente     TEXT,
    clicando    INTEGER,
    data        TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_eventos_usuario ON eventos (usuario_id, id);
  CREATE INDEX IF NOT EXISTS idx_refresh_usuario ON refresh_tokens (usuario_id);
`);

const sql = {
  criarUsuario: db.prepare("INSERT INTO usuarios (email, senha_hash, criado_em) VALUES (?, ?, ?)"),
  usuarioPorEmail: db.prepare("SELECT * FROM usuarios WHERE email = ?"),
  usuarioPorId: db.prepare("SELECT id, email, criado_em FROM usuarios WHERE id = ?"),

  salvarRefresh: db.prepare(
    "INSERT INTO refresh_tokens (usuario_id, token_hash, dispositivo, expira_em, criado_em) VALUES (?, ?, ?, ?, ?)"
  ),
  refreshPorHash: db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?"),
  apagarRefresh: db.prepare("DELETE FROM refresh_tokens WHERE id = ?"),
  apagarRefreshExpirados: db.prepare("DELETE FROM refresh_tokens WHERE expira_em < ?"),

  inserirEvento: db.prepare(
    "INSERT INTO eventos (usuario_id, tipo, mensagem, cliente, clicando, data) VALUES (?, ?, ?, ?, ?, ?)"
  ),
  eventosDesde: db.prepare(
    "SELECT * FROM eventos WHERE usuario_id = ? AND id > ? ORDER BY id LIMIT ?"
  ),
  ultimosEventos: db.prepare(
    "SELECT * FROM (SELECT * FROM eventos WHERE usuario_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id"
  ),
  podarEventos: db.prepare(`
    DELETE FROM eventos WHERE usuario_id = ? AND id <= (
      SELECT id FROM eventos WHERE usuario_id = ? ORDER BY id DESC LIMIT 1 OFFSET ${EVENTOS_POR_USUARIO}
    )`),
};

function linhaParaEvento(linha) {
  return {
    id: Number(linha.id),
    tipo: linha.tipo,
    mensagem: linha.mensagem,
    cliente: linha.cliente,
    clicando: linha.clicando === null ? undefined : Boolean(linha.clicando),
    data: linha.data,
  };
}

module.exports = { db, sql, linhaParaEvento };
