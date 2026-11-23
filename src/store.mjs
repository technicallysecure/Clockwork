import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { memoryScope } from './context.mjs';

export function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function requiredText(value, name, maximum = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw badRequest(`${name} must contain 1–${maximum} characters.`);
  }
  return value.trim();
}

export function openStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, profileId TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_scope_id ON messages(scope,id);
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_scope_kind ON memories(scope,kind);
  `);
  return db;
}

export class Notebook {
  constructor(db) {
    this.db = db;
  }

  memories(scope, kind) {
    return this.db.prepare('SELECT id,text,done,createdAt FROM memories WHERE scope=? AND kind=? ORDER BY id DESC')
      .all(scope, kind).map(row => ({ ...row, done: Boolean(row.done) }));
  }

  add(scope, kind, text) {
    const result = this.db.prepare('INSERT INTO memories(scope,kind,text,createdAt) VALUES(?,?,?,?)')
      .run(scope, kind, requiredText(text, 'Entry', 2000), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  update(scope, kind, id, change) {
    let result;
    if (kind === 'commitment') {
      if (typeof change.done !== 'boolean') throw badRequest('Choose an open or completed commitment.');
      result = this.db.prepare('UPDATE memories SET done=? WHERE id=? AND scope=? AND kind=?')
        .run(Number(change.done), id, scope, kind);
    } else {
      result = this.db.prepare('UPDATE memories SET text=? WHERE id=? AND scope=? AND kind=?')
        .run(requiredText(change.text, 'Preference', 2000), id, scope, kind);
    }
    if (!result.changes) throw badRequest('Entry not found in this memory scope.', 404);
  }

  removePreference(scope, id) {
    const result = this.db.prepare("DELETE FROM memories WHERE scope=? AND kind='preference' AND id=?").run(scope, id);
    if (!result.changes) throw badRequest('Preference not found in this memory scope.', 404);
  }

  messages(scope, limit, before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT id,role,content,profileId,createdAt FROM messages WHERE scope=? AND id<? ORDER BY id DESC LIMIT ?')
      .all(scope, before, limit).reverse();
  }

  append(profile, role, content) {
    this.db.prepare('INSERT INTO messages(scope,role,content,profileId,createdAt) VALUES(?,?,?,?,?)')
      .run(memoryScope(profile), role, content, profile.id, new Date().toISOString());
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
}
