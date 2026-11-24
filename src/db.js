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

// ------------------------------------------------------------ Phase 2 schema
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function addColumn(table, col, def) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

addColumn('messages', 'snooze_until', 'TEXT');
addColumn('messages', 'spam_score', 'REAL');
addColumn('messages', 'auth_results', 'TEXT');          // SPF/DKIM/DMARC verdicts (JSON)
addColumn('users', 'totp_secret', 'TEXT');
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'ooo_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'ooo_subject', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'ooo_message', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'ooo_start', 'TEXT');
addColumn('users', 'ooo_end', 'TEXT');
addColumn('users', 'undo_send_seconds', 'INTEGER NOT NULL DEFAULT 10');
addColumn('users', 'focused_inbox', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'mailbox_type', "TEXT NOT NULL DEFAULT 'user'");   // user | shared (shared: no sign-in)
addColumn('users', 'trash_days', 'INTEGER NOT NULL DEFAULT 30');       // empty Deleted Items after N days (0 = never)
addColumn('organizations', 'retention_days', 'INTEGER NOT NULL DEFAULT 0');   // 0 = keep forever
addColumn('organizations', 'litigation_hold', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_saved INTEGER NOT NULL DEFAULT 0,       -- 0 = auto-collected from sent mail
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used TEXT,
  UNIQUE(user_id, email)
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  conditions_json TEXT NOT NULL,   -- [{field: from|to|subject|body|has_attachment, op: contains|equals, value}]
  actions_json TEXT NOT NULL,      -- [{type: move|read|flag|category|delete|forward|stop, value}]
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sender_lists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,           -- full address or @domain
  kind TEXT NOT NULL,              -- safe | blocked
  UNIQUE(user_id, address)
);

CREATE TABLE IF NOT EXISTS auto_reply_log (
  user_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, sender)
);

-- Aliases: extra addresses that deliver to a user's mailbox
CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

-- Distribution groups (private organizations): mail to the group goes to every member
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  allow_external INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

-- Delegation: delegate_id may open owner_id's mailbox (shared mailboxes use this too)
CREATE TABLE IF NOT EXISTS delegates (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'full',   -- read | send_on_behalf | send_as | full
  PRIMARY KEY (owner_id, delegate_id)
);

-- Organization mail flow (transport) rules
CREATE TABLE IF NOT EXISTS transport_rules (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  match_json TEXT NOT NULL,     -- {externalRecipients: bool, subjectContains: str, bodyContains: str}
  action TEXT NOT NULL,         -- block | disclaimer
  value TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Audit log (security and compliance)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  org_id INTEGER,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, created_at DESC);

-- Outgoing mail queue: undo send, scheduled send, retries
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,      -- the compose request
  send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | sent | failed | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_message_id INTEGER,
  scheduled INTEGER NOT NULL DEFAULT 0,     -- 1 = user chose a later time
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, send_at);

-- Pending remote deliveries (retry with backoff)
CREATE TABLE IF NOT EXISTS delivery_queue (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  raw_path TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  rcpts_json TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  next_attempt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
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
