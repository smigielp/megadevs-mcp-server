const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DATA_DIR lets the deployment point at a persistent volume (e.g. a Railway volume mounted at /data).
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'memos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS memos (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memos_created_at ON memos(created_at);
  CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(
    id UNINDEXED,
    text,
    content=memos,
    content_rowid=rowid
  );

  CREATE TRIGGER IF NOT EXISTS memos_fts_insert AFTER INSERT ON memos BEGIN
    INSERT INTO memos_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS memos_fts_delete AFTER DELETE ON memos BEGIN
    INSERT INTO memos_fts(memos_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS memos_fts_update AFTER UPDATE ON memos BEGIN
    INSERT INTO memos_fts(memos_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
    INSERT INTO memos_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
  END;

  -- OAuth 2.1 authorization server state
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    info TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_pending (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    params TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);
`);

module.exports = db;
module.exports.dataDir = dataDir;
