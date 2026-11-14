const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'memos.db');
const db = new Database(dbPath);

// Initialize database schema
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
`);

module.exports = db;
