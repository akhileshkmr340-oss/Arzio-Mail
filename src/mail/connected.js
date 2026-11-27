// Connected accounts: use a mailbox that lives at another provider (Hostinger,
// Zoho, Gmail, any IMAP/SMTP host) from inside Arzio, like Outlook's "Add
// account". New mail is copied from the account's IMAP inbox into its own
// Arzio folder every few minutes, and mail sent "From" that address goes out
// through the account's own SMTP server, so its SPF/DKIM stay valid and the
// domain's DNS does not change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { db, isJobLeader } from '../db.js';
import { config } from '../config.js';
import { audit } from '../audit.js';
import * as store from './store.js';
import { importRaw, isPrivateHost } from './import.js';

const httpErr = (status, message) => Object.assign(new Error(message), { status });

db.exec(`CREATE TABLE IF NOT EXISTS connected_accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL DEFAULT 465,
  smtp_secure INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  folder_id INTEGER,
  uid_validity TEXT,
  last_uid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',           -- ok | error
  last_error TEXT,
  last_sync_at TEXT,
  imported INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, address)
)`);

// Common providers. Hostinger Business Email is what arfoodss.com uses.
export const PROVIDERS = {
  hostinger: { name: 'Hostinger Email', imap: { host: 'imap.hostinger.com', port: 993, secure: true }, smtp: { host: 'smtp.hostinger.com', port: 465, secure: true }, note: 'Use the mailbox password you set in hPanel (Emails > Manage).' },
  zoho: { name: 'Zoho Mail', imap: { host: 'imap.zoho.com', port: 993, secure: true }, smtp: { host: 'smtp.zoho.com', port: 465, secure: true }, note: 'Turn on IMAP access in Zoho Mail settings.' },
  gmail: { name: 'Gmail / Google Workspace', imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, note: 'Needs 2-Step Verification and an app password (myaccount.google.com/apppasswords).' },
  outlook: { name: 'Outlook / Microsoft 365', imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false }, note: 'Your admin must allow IMAP and SMTP AUTH for the mailbox.' },
  yahoo: { name: 'Yahoo Mail', imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true }, note: 'Create an app password in Yahoo account security.' },
};

// ------------------------------------------------------------ password encryption
// AES-256-GCM. The key comes from ARZIO_SECRET_KEY (set it when several servers
// share one database), otherwise one is generated into the data folder.
let key;
function secretKey() {
  if (key) return key;
  if (process.env.ARZIO_SECRET_KEY) {
    key = crypto.createHash('sha256').update(process.env.ARZIO_SECRET_KEY).digest();
    return key;
  }
  const file = path.join(config.dataDir, 'secret.key');
  try {
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  } catch {
    fs.mkdirSync(config.dataDir, { recursive: true });
    key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  }
  return key;
}
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

// ------------------------------------------------------------ connections
const plainAllowed = () => process.env.ARZIO_IMPORT_ALLOW_PRIVATE === '1';

function imapClient(a, password) {
  return new ImapFlow({ host: a.imap_host, port: a.imap_port, secure: !!a.imap_secure, auth: { user: a.username, pass: password }, logger: false, socketTimeout: 60000, ...(a.imap_secure || plainAllowed() ? {} : { doSTARTTLS: true }) });
}
function smtpTransport(a, password) {
  return nodemailer.createTransport({
    host: a.smtp_host, port: a.smtp_port, secure: !!a.smtp_secure,
    // Without implicit TLS, insist on STARTTLS so the password never goes in clear
    requireTLS: !a.smtp_secure && !plainAllowed(), ignoreTLS: !a.smtp_secure && plainAllowed(),
    auth: { user: a.username, pass: password },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
  });
}

const PUBLIC_FIELDS = 'id, address, display_name, imap_host, imap_port, smtp_host, smtp_port, username, folder_id, status, last_error, last_sync_at, imported, created_at';
export const listAccounts = (userId) => db.prepare(`SELECT ${PUBLIC_FIELDS} FROM connected_accounts WHERE user_id = ? ORDER BY address`).all(userId);
const accountRow = (userId, id) => db.prepare('SELECT * FROM connected_accounts WHERE id = ? AND user_id = ?').get(Number(id), userId);
export const accountForAddress = (userId, address) => db.prepare('SELECT * FROM connected_accounts WHERE user_id = ? AND address = ?').get(userId, String(address || '').toLowerCase());

function cleanHost(h, what) {
  const host = String(h || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) throw httpErr(400, `Enter a valid ${what} server name.`);
  return host;
}

/**
 * Add a connected account. Signs in to IMAP and SMTP first so a wrong password
 * or server is reported straight away, then starts the first sync.
 */
export async function addAccount(user, input) {
  if (config.demo) throw httpErr(403, 'The public demo is one shared account, so connecting a real mailbox is turned off here. Use your own Arzio server.');
  const preset = PROVIDERS[input.provider] || {};
  const address = String(input.address || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw httpErr(400, 'Enter the email address of the account.');
  const password = String(input.password || '');
  if (!password) throw httpErr(400, 'Enter the account password.');
  if (accountForAddress(user.id, address)) throw httpErr(409, `${address} is already connected.`);
  if (db.prepare('SELECT COUNT(*) AS n FROM connected_accounts WHERE user_id = ?').get(user.id).n >= 10) throw httpErr(400, 'You can connect up to 10 accounts.');
  const a = {
    address,
    display_name: String(input.name || user.name || '').slice(0, 120),
    imap_host: cleanHost(input.imapHost || preset.imap?.host, 'IMAP'),
    imap_port: Number(input.imapPort || preset.imap?.port || 993),
    imap_secure: (input.imapSecure ?? preset.imap?.secure ?? true) ? 1 : 0,
    smtp_host: cleanHost(input.smtpHost || preset.smtp?.host, 'SMTP'),
    smtp_port: Number(input.smtpPort || preset.smtp?.port || 465),
    smtp_secure: (input.smtpSecure ?? preset.smtp?.secure ?? true) ? 1 : 0,
    username: String(input.username || address).trim(),
  };
  for (const h of [a.imap_host, a.smtp_host]) if (await isPrivateHost(h)) throw httpErr(400, `${h} is not reachable from Arzio.`);

  const client = imapClient(a, password);
  try {
    await client.connect();
  } catch (e) {
    throw httpErr(400, `Could not sign in to ${a.imap_host}: ${e.responseText || e.message}`);
  } finally {
    client.logout().catch(() => client.close());
  }
  try {
    await smtpTransport(a, password).verify();
  } catch (e) {
    throw httpErr(400, `Signed in to read mail, but sending through ${a.smtp_host}:${a.smtp_port} failed: ${e.response || e.message}`);
  }

  const folderName = address.slice(0, 80);
  const folder = db.prepare('SELECT id FROM folders WHERE user_id = ? AND name = ?').get(user.id, folderName) || store.createFolder(user.id, folderName);
  const r = db.prepare(`INSERT INTO connected_accounts (user_id, address, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc, folder_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, a.address, a.display_name, a.imap_host, a.imap_port, a.imap_secure, a.smtp_host, a.smtp_port, a.smtp_secure, a.username, encrypt(password), folder.id);
  const id = Number(r.lastInsertRowid);
  audit(user.id, 'account.connect', { address, imap: a.imap_host, smtp: a.smtp_host });
  await syncAccount(id).catch(() => {});
  return db.prepare(`SELECT ${PUBLIC_FIELDS} FROM connected_accounts WHERE id = ?`).get(id);
}

export function updateAccount(user, id, input) {
  const a = accountRow(user.id, id);
  if (!a) throw httpErr(404, 'Account not found.');
  if (input.name !== undefined) db.prepare('UPDATE connected_accounts SET display_name = ? WHERE id = ?').run(String(input.name).slice(0, 120), a.id);
  if (input.password) db.prepare("UPDATE connected_accounts SET password_enc = ?, status = 'ok', last_error = NULL WHERE id = ?").run(encrypt(input.password), a.id);
  return db.prepare(`SELECT ${PUBLIC_FIELDS} FROM connected_accounts WHERE id = ?`).get(a.id);
}

/** Disconnect. Mail already copied stays in its folder. */
export function removeAccount(user, id) {
  const a = accountRow(user.id, id);
  if (!a) throw httpErr(404, 'Account not found.');
  db.prepare('DELETE FROM connected_accounts WHERE id = ?').run(a.id);
  audit(user.id, 'account.disconnect', { address: a.address });
}

// ------------------------------------------------------------ receiving
const syncing = new Set();
const FIRST_SYNC = 500; // newest messages copied when an account is first connected

/** Copy new mail from the account's IMAP inbox into its Arzio folder. */
export async function syncAccount(id) {
  if (syncing.has(id)) return { skipped: true };
  const a = db.prepare('SELECT * FROM connected_accounts WHERE id = ?').get(Number(id));
  if (!a) return { skipped: true };
  syncing.add(id);
  let client;
  let imported = 0;
  try {
    let folderId = a.folder_id;
    if (!folderId || !store.folderById(a.user_id, folderId)) {
      folderId = (db.prepare('SELECT id FROM folders WHERE user_id = ? AND name = ?').get(a.user_id, a.address.slice(0, 80)) || store.createFolder(a.user_id, a.address.slice(0, 80))).id;
      db.prepare('UPDATE connected_accounts SET folder_id = ? WHERE id = ?').run(folderId, a.id);
    }
    client = imapClient(a, decrypt(a.password_enc));
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const validity = String(client.mailbox.uidValidity);
      // A new UIDVALIDITY means the server renumbered: start again (duplicates are skipped)
      let lastUid = validity === a.uid_validity ? a.last_uid : 0;
      if (client.mailbox.exists) {
        let range = `${lastUid + 1}:*`;
        if (!lastUid) {
          const uids = (await client.search({ all: true }, { uid: true })) || [];
          range = uids.length ? `${uids.slice(-FIRST_SYNC)[0]}:*` : null;
        }
        if (range) {
          for await (const msg of client.fetch(range, { uid: true, source: true, flags: true }, { uid: true })) {
            if (msg.uid <= lastUid) continue; // "N:*" always returns the newest message
            if (await importRaw(a.user_id, msg.source, folderId, { seen: msg.flags?.has('\\Seen'), flagged: msg.flags?.has('\\Flagged') })) imported++;
            lastUid = Math.max(lastUid, msg.uid);
          }
        }
      }
      db.prepare("UPDATE connected_accounts SET uid_validity = ?, last_uid = ?, imported = imported + ?, status = 'ok', last_error = NULL, last_sync_at = datetime('now') WHERE id = ?")
        .run(validity, lastUid, imported, a.id);
    } finally {
      lock.release();
    }
    return { imported };
  } catch (e) {
    const msg = String(e.responseText || e.message).slice(0, 500);
    db.prepare("UPDATE connected_accounts SET status = 'error', last_error = ?, last_sync_at = datetime('now') WHERE id = ?").run(msg, a.id);
    throw httpErr(502, `Could not get mail from ${a.imap_host}: ${msg}`);
  } finally {
    syncing.delete(id);
    if (client) client.logout().catch(() => client.close());
  }
}

/** Background sync of every account, a few minutes apart. */
export async function syncAllOnce() {
  if (!isJobLeader()) return;
  const every = Number(process.env.ARZIO_CONNECTED_SYNC_MINUTES || 3);
  const due = db.prepare(`SELECT id FROM connected_accounts WHERE last_sync_at IS NULL OR last_sync_at <= datetime('now', '-${every} minutes') ORDER BY last_sync_at LIMIT 20`).all();
  for (const { id } of due) await syncAccount(id).catch(() => {});
}

export function startConnectedSync(intervalMs = 60000) {
  if (config.demo) return null;
  const t = setInterval(() => { syncAllOnce().catch((e) => console.error('[connected]', e)); }, intervalMs);
  t.unref();
  return t;
}

// ------------------------------------------------------------ sending
export function connectedIdentities(user) {
  return db.prepare('SELECT id, address, display_name FROM connected_accounts WHERE user_id = ?').all(user.id)
    .map((a) => ({ address: a.address, name: a.display_name || user.name, mailboxId: user.id, onBehalf: false, connectedId: a.id }));
}

/**
 * Send a finished message through the account's own SMTP server, then save a
 * copy in its Sent folder on that server so its own webmail shows it too.
 */
export async function sendViaAccount(userId, address, raw, rcpts) {
  const a = accountForAddress(userId, address);
  if (!a) throw httpErr(403, 'That account is no longer connected.');
  const password = decrypt(a.password_enc);
  const info = await smtpTransport(a, password).sendMail({ envelope: { from: a.address, to: rcpts }, raw });
  appendSent(a, password, raw).catch(() => {});
  return info;
}

async function appendSent(a, password, raw) {
  const client = imapClient(a, password);
  try {
    await client.connect();
    const boxes = await client.list();
    const sent = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => /^(INBOX[./])?Sent( Items| Messages| Mail)?$/i.test(b.path));
    if (sent) await client.append(sent.path, raw, ['\\Seen']);
  } finally {
    client.logout().catch(() => client.close());
  }
}
