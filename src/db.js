// SQLite storage (built into Node 22). Schema is designed to port to PostgreSQL
// in a later phase: plain tables, integer ids, JSON columns as TEXT.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'arzio.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Tenants. The public consumer service (free signups on the Arzio domain) is
-- itself an organization with kind = 'public'; businesses are kind = 'private'.
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'private',      -- public | private
  max_users INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mail domains owned by a tenant. Private tenants prove ownership with a DNS TXT record.
CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  verify_token TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL DEFAULT 'user',          -- user | org_admin
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,        -- service-wide operator (superadmin)
  is_disabled INTEGER NOT NULL DEFAULT 0,
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  signature TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  signup_ip TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,            -- inbox | sent | drafts | archive | junk | trash | NULL for custom
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  thread_id TEXT NOT NULL,
  message_id TEXT,            -- RFC 5322 Message-ID
  in_reply_to TEXT,
  refs TEXT,
  from_addr TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_focused INTEGER NOT NULL DEFAULT 1,
  categories_json TEXT NOT NULL DEFAULT '[]',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  ai_priority TEXT,           -- high | normal | low
  ai_category TEXT,           -- e.g. personal, work, finance, promotions, social, updates
  ai_needs_reply INTEGER,
  ai_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(user_id, folder_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(user_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(user_id, message_id);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  content_id TEXT
);

CREATE TABLE IF NOT EXISTS send_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(subject, body, people);
`);

export const SYSTEM_FOLDERS = [
  ['Inbox', 'inbox'],
  ['Drafts', 'drafts'],
  ['Sent Items', 'sent'],
  ['Archive', 'archive'],
  ['Junk Email', 'junk'],
  ['Deleted Items', 'trash'],
];

// Make sure the public consumer tenant and its domain exist.
export function ensurePublicTenant(primaryDomain, serviceName) {
  let org = db.prepare("SELECT * FROM organizations WHERE kind = 'public' LIMIT 1").get();
  if (!org) {
    const r = db.prepare("INSERT INTO organizations (name, kind, max_users) VALUES (?, 'public', 0)").run(serviceName);
    org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(r.lastInsertRowid);
  }
  if (!db.prepare('SELECT 1 FROM domains WHERE name = ?').get(primaryDomain)) {
    db.prepare("INSERT INTO domains (org_id, name, verify_token, verified) VALUES (?, ?, 'system', 1)").run(org.id, primaryDomain);
  }
  return org;
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
