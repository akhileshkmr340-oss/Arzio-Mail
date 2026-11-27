// Mail migration: copy mail into an Arzio mailbox from Gmail, Microsoft 365,
// Yahoo or any IMAP server, or from .eml / .mbox files (Google Takeout exports .mbox).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db } from '../db.js';
import { storageLimit } from '../billing.js';
import { config } from '../config.js';
import * as store from './store.js';
import { audit } from '../audit.js';

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const ROLE_BY_USE = { '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Junk': 'junk', '\\Trash': 'trash', '\\Archive': 'archive' };
const list = (v) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x) => x.value || []) : [])
  .map((a) => ({ address: String(a.address || '').toLowerCase(), name: a.name || '' })).filter((a) => a.address);

export const PRESETS = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true, note: 'Turn on 2-Step Verification in your Google account and create an app password (myaccount.google.com/apppasswords).' },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true, note: 'Microsoft 365 work accounts need IMAP enabled by the admin. Personal Outlook.com accounts may need an app password.' },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true, note: 'Create an app password in Yahoo account security.' },
  zoho: { host: 'imap.zoho.com', port: 993, secure: true, note: 'Enable IMAP access in Zoho Mail settings.' },
};

function job(userId, source) {
  const r = db.prepare('INSERT INTO import_jobs (user_id, source) VALUES (?, ?)').run(userId, source);
  const id = Number(r.lastInsertRowid);
  return {
    id,
    progress(fields) {
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE import_jobs SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
    },
  };
}

/** Store one raw message unless it is already in the mailbox. Returns true if added. */
export async function importRaw(userId, raw, folderId, { seen = true, flagged = false } = {}) {
  if (store.mailboxUsage(userId) + raw.length > storageLimit(userId)) throw httpErr(507, 'Mailbox is full.');
  const parsed = await simpleParser(raw);
  if (parsed.messageId && db.prepare('SELECT 1 FROM messages WHERE user_id = ? AND message_id = ?').get(userId, parsed.messageId)) return false;
  const id = store.storeMessage(userId, {
    folderId, messageId: parsed.messageId || null, inReplyTo: parsed.inReplyTo || null,
    refs: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || null,
    from: list(parsed.from)[0] || { address: '', name: '' }, to: list(parsed.to), cc: list(parsed.cc),
    subject: parsed.subject || '', text: parsed.text || '', html: typeof parsed.html === 'string' ? parsed.html : '',
    date: parsed.date || new Date(), size: raw.length, raw, isRead: seen,
    attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content, contentId: a.contentId })),
  });
  if (flagged) db.prepare('UPDATE messages SET is_flagged = 1 WHERE id = ?').run(id);
  return true;
}

function folderFor(userId, box) {
  const role = box.path.toUpperCase() === 'INBOX' ? 'inbox' : ROLE_BY_USE[box.specialUse];
  if (role) return store.folderByRole(userId, role).id;
  const name = box.path.replace(/^\[Gmail\]\//, '').slice(0, 80);
  const existing = db.prepare('SELECT id FROM folders WHERE user_id = ? AND name = ?').get(userId, name);
  return existing ? existing.id : store.createFolder(userId, name).id;
}

/** Start copying mail from another IMAP account. Runs in the background; returns the job id. */
export async function startImapImport(user, { host, port = 993, secure = true, username, password, maxPerFolder = 20000 }) {
  if (!host || !username || !password) throw httpErr(400, 'Enter the server, username and password.');
  if (!/^[a-z0-9.-]+$/i.test(host)) throw httpErr(400, 'Enter a valid server name.');
  if (await isPrivateHost(host)) throw httpErr(400, 'That server is not reachable from Arzio.');
  const client = new ImapFlow({ host, port: Number(port), secure: !!secure, auth: { user: username, pass: password }, logger: false, socketTimeout: 120000 });
  try {
    await client.connect();
  } catch (e) {
    client.close();
    throw httpErr(400, `Could not sign in to ${host}: ${e.responseText || e.message}`);
  }
  const j = job(user.id, `${username} @ ${host}`);
  audit(user.id, 'import.start', { source: host, account: username });
  setImmediate(async () => {
    let imported = 0;
    let skipped = 0;
    try {
      const boxes = (await client.list()).filter((b) => !b.flags.has('\\Noselect') && b.specialUse !== '\\All' && b.specialUse !== '\\Flagged' && !/^\[Gmail\]\/(Important|Starred|All Mail)$/i.test(b.path));
      for (const box of boxes) {
        j.progress({ current: box.path });
        const folderId = folderFor(user.id, box);
        const lock = await client.getMailboxLock(box.path);
        try {
          if (!client.mailbox.exists) continue;
          let n = 0;
          for await (const msg of client.fetch('1:*', { source: true, flags: true })) {
            if (++n > maxPerFolder) break;
            if (await importRaw(user.id, msg.source, folderId, { seen: msg.flags?.has('\\Seen'), flagged: msg.flags?.has('\\Flagged') })) imported++; else skipped++;
            if ((imported + skipped) % 25 === 0) j.progress({ imported, skipped });
          }
        } finally {
          lock.release();
        }
      }
      j.progress({ imported, skipped, status: 'done', current: '', finished_at: new Date().toISOString() });
      audit(user.id, 'import.done', { source: host, imported });
    } catch (e) {
      j.progress({ imported, skipped, status: 'failed', error: String(e.message).slice(0, 500), finished_at: new Date().toISOString() });
    } finally {
      client.logout().catch(() => {});
    }
  });
  return j.id;
}

// Don't let the import feature be used to reach internal services
export async function isPrivateHost(host) {
  if (process.env.ARZIO_IMPORT_ALLOW_PRIVATE === '1') return false;
  const { lookup } = await import('node:dns/promises');
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some(({ address: a }) => /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd]|fe80)/i.test(a));
  } catch {
    return false;
  }
}

/** Import an .eml file or an .mbox archive (e.g. Google Takeout). Returns counts. */
export async function importFile(user, { filename, content, folderId }) {
  const fid = folderId ? store.folderById(user.id, folderId)?.id : store.folderByRole(user.id, 'archive').id;
  if (!fid) throw httpErr(404, 'Folder not found.');
  const text = content.toString('latin1');
  const isMbox = /\.mbox$/i.test(filename || '') || /^From [^\r\n]*\r?\n/.test(text);
  const raws = isMbox
    ? text.split(/\r?\n(?=From [^\r\n]*\r?\n)/).map((m) => m.replace(/^From [^\r\n]*\r?\n/, '').replace(/^>(>*From )/gm, '$1')).filter((m) => m.trim())
    : [text];
  let imported = 0;
  let skipped = 0;
  for (const r of raws.slice(0, 50000)) {
    if (await importRaw(user.id, Buffer.from(r, 'latin1'), fid)) imported++; else skipped++;
  }
  audit(user.id, 'import.file', { filename, imported, skipped });
  return { imported, skipped };
}

export function listJobs(userId) {
  return db.prepare('SELECT * FROM import_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(userId);
}
