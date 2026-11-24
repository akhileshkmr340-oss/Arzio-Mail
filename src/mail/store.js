// Mailbox storage: folders, messages, threading, attachments, full-text search.
import crypto from 'node:crypto';
import { db, tx } from '../db.js';
import { config } from '../config.js';
import * as blobs from '../blobs.js';


export function folderByRole(userId, role) {
  return db.prepare('SELECT * FROM folders WHERE user_id = ? AND role = ?').get(userId, role);
}

export function folderById(userId, id) {
  return db.prepare('SELECT * FROM folders WHERE user_id = ? AND id = ?').get(userId, Number(id));
}

export function listFolders(userId) {
  return db.prepare(`
    SELECT f.id, f.name, f.role,
      (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.is_read = 0) AS unread,
      (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id) AS total
    FROM folders f WHERE f.user_id = ? AND (f.role IS NULL OR f.role != 'recoverable')
    ORDER BY CASE f.role WHEN 'inbox' THEN 1 WHEN 'drafts' THEN 2 WHEN 'sent' THEN 3 WHEN 'archive' THEN 4
      WHEN 'junk' THEN 5 WHEN 'trash' THEN 6 ELSE 7 END, f.name`).all(userId);
}

export function createFolder(userId, name) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw Object.assign(new Error('Folder name is required.'), { status: 400 });
  try {
    const r = db.prepare('INSERT INTO folders (user_id, name, role) VALUES (?, ?, NULL)').run(userId, n);
    return folderById(userId, r.lastInsertRowid);
  } catch {
    throw Object.assign(new Error('A folder with that name already exists.'), { status: 409 });
  }
}

export function renameFolder(userId, id, name) {
  const f = folderById(userId, id);
  if (!f || f.role) throw Object.assign(new Error('Only custom folders can be renamed.'), { status: 400 });
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 80), f.id);
  return folderById(userId, id);
}

export function deleteFolder(userId, id) {
  const f = folderById(userId, id);
  if (!f || f.role) throw Object.assign(new Error('Only custom folders can be deleted.'), { status: 400 });
  const trash = folderByRole(userId, 'trash');
  tx(() => {
    db.prepare('UPDATE messages SET folder_id = ? WHERE folder_id = ?').run(trash.id, f.id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(f.id);
  });
}

export function mailboxUsage(userId) {
  return db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM messages WHERE user_id = ?').get(userId).bytes;
}

function normSubject(s) {
  return String(s || '').replace(/^(\s*(re|fw|fwd|aw|sv)\s*:\s*)+/i, '').trim().toLowerCase();
}

// Find an existing thread via In-Reply-To / References, else start a new one.
export function resolveThread(userId, { inReplyTo, refs, subject }) {
  const ids = [inReplyTo, ...String(refs || '').split(/\s+/)].filter(Boolean);
  const find = db.prepare('SELECT thread_id FROM messages WHERE user_id = ? AND message_id = ? LIMIT 1');
  for (const id of ids) {
    const row = find.get(userId, id);
    if (row) return row.thread_id;
  }
  // Fallback: same normalized subject within the last 14 days, only for replies
  if (/^\s*(re|aw|sv)\s*:/i.test(subject || '') && normSubject(subject)) {
    const rows = db.prepare(`SELECT thread_id, subject FROM messages WHERE user_id = ? AND date > datetime('now', '-14 days') ORDER BY date DESC LIMIT 200`).all(userId);
    const hit = rows.find((r) => normSubject(r.subject) === normSubject(subject));
    if (hit) return hit.thread_id;
  }
  return crypto.randomUUID();
}

export function makeSnippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Insert a message into one user's mailbox.
 * msg: { folderRole|folderId, messageId, inReplyTo, refs, from:{address,name}, to:[{address,name}], cc, bcc,
 *        subject, text, html, date, size, isRead, attachments:[{filename, contentType, content(Buffer), contentId}] }
 */
export function storeMessage(userId, msg) {
  const folder = msg.folderId ? folderById(userId, msg.folderId) : folderByRole(userId, msg.folderRole || 'inbox');
  if (!folder) throw new Error('Folder not found');
  const text = msg.text || htmlToText(msg.html);
  const threadId = msg.threadId || resolveThread(userId, { inReplyTo: msg.inReplyTo, refs: msg.refs, subject: msg.subject });
  const atts = msg.attachments || [];
  const size = msg.size || Buffer.byteLength(text) + Buffer.byteLength(msg.html || '') + atts.reduce((s, a) => s + (a.content?.length || 0), 0);

  return tx(() => {
    const r = db.prepare(`INSERT INTO messages
      (user_id, folder_id, thread_id, message_id, in_reply_to, refs, from_addr, from_name, to_json, cc_json, bcc_json,
       subject, text_body, html_body, snippet, date, size, is_read, has_attachments, is_focused)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      userId, folder.id, threadId, msg.messageId || null, msg.inReplyTo || null, msg.refs || null,
      (msg.from?.address || '').toLowerCase(), msg.from?.name || '',
      JSON.stringify(msg.to || []), JSON.stringify(msg.cc || []), JSON.stringify(msg.bcc || []),
      String(msg.subject || '').slice(0, 998), text, msg.html || '', makeSnippet(text),
      (msg.date ? new Date(msg.date) : new Date()).toISOString(), size, msg.isRead ? 1 : 0, atts.length ? 1 : 0,
      msg.isFocused === false ? 0 : 1);
    const id = Number(r.lastInsertRowid);
    if (msg.raw) {
      // Keep the original MIME so IMAP clients get byte-exact messages
      const rawPath = blobs.put('raw', `${id}-${crypto.randomUUID()}.eml`, msg.raw);
      db.prepare('UPDATE messages SET raw_path = ? WHERE id = ?').run(rawPath, id);
    }
    for (const a of atts) {
      const storage = blobs.put('attachments', `${id}-${crypto.randomUUID()}`, a.content);
      db.prepare('INSERT INTO attachments (message_id, filename, content_type, size, storage_path, content_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, String(a.filename || 'attachment').slice(0, 255), a.contentType || 'application/octet-stream', a.content.length, storage, a.contentId || null);
    }
    const people = [msg.from?.name, msg.from?.address, ...(msg.to || []).flatMap((p) => [p.name, p.address]), ...(msg.cc || []).flatMap((p) => [p.name, p.address])].filter(Boolean).join(' ');
    db.prepare('INSERT INTO messages_fts (rowid, subject, body, people) VALUES (?, ?, ?, ?)').run(id, msg.subject || '', text, people);
    return id;
  });
}

const LIST_COLS = `id, folder_id, thread_id, from_addr, from_name, to_json, subject, snippet, date, is_read, is_flagged, is_pinned,
  is_focused, categories_json, has_attachments, ai_priority, ai_category, ai_needs_reply, snooze_until, spam_score, importance, mentions_me, flag_due_at, flag_completed_at`;

function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of ['to_json', 'cc_json', 'bcc_json', 'categories_json']) {
    if (k in out) { out[k.replace('_json', '')] = JSON.parse(out[k] || '[]'); delete out[k]; }
  }
  for (const k of ['is_read', 'is_flagged', 'is_pinned', 'is_focused', 'has_attachments', 'mentions_me']) if (k in out) out[k] = !!out[k];
  if ('ai_needs_reply' in out && out.ai_needs_reply !== null) out.ai_needs_reply = !!out.ai_needs_reply;
  return out;
}

// Mail kept for litigation hold lives in a hidden "Recoverable Items" folder
const NOT_HELD = "m.folder_id NOT IN (SELECT id FROM folders WHERE user_id = m.user_id AND role = 'recoverable')";

export function recoverableFolder(userId) {
  let f = folderByRole(userId, 'recoverable');
  if (!f) {
    db.prepare("INSERT OR IGNORE INTO folders (user_id, name, role) VALUES (?, 'Recoverable Items (hold)', 'recoverable')").run(userId);
    f = folderByRole(userId, 'recoverable');
  }
  return f;
}

export function listMessages(userId, { folderId, focus, q, limit = 50, offset = 0, flagged, snoozed, category, unread, mentions, filter, sort }) {
  const where = ['m.user_id = ?'];
  const args = [userId];
  let from = 'messages m';
  if (q) {
    // Search across all folders except Trash/Junk unless a folder is given
    from = 'messages m JOIN messages_fts f ON f.rowid = m.id';
    where.push(FTS_MATCH);
    args.push(ftsQuery(q));
  }
  if (folderId) { where.push('m.folder_id = ?'); args.push(Number(folderId)); } else where.push(NOT_HELD);
  if (flagged) where.push('m.is_flagged = 1');
  if (snoozed) where.push('m.snooze_until IS NOT NULL');
  else where.push('m.snooze_until IS NULL');
  if (category) { where.push("m.categories_json LIKE ?"); args.push(`%${JSON.stringify(String(category)).slice(1, -1)}%`); }
  if (unread) where.push('m.is_read = 0');
  if (mentions) where.push('m.mentions_me = 1');
  // Ribbon "Filter Email" choices
  if (filter === 'unread') where.push('m.is_read = 0');
  if (filter === 'flagged') where.push('m.is_flagged = 1');
  if (filter === 'attachments') where.push('m.has_attachments = 1');
  if (filter === 'mentions') where.push('m.mentions_me = 1');
  if (filter === 'important') where.push("m.importance = 'high'");
  if (filter === 'categorized') where.push("m.categories_json <> '[]'");
  if (filter === 'tome') {
    const me = db.prepare('SELECT email FROM users WHERE id = ?').get(userId)?.email || '';
    where.push('m.to_json LIKE ?'); args.push(`%"${me}"%`);
  }
  if (filter === 'week') { where.push('m.date >= ?'); args.push(new Date(Date.now() - 7 * 86400e3).toISOString()); }
  if (focus === 'focused') where.push('m.is_focused = 1');
  if (focus === 'other') where.push('m.is_focused = 0');
  const sql = `SELECT ${LIST_COLS.split(',').map((c) => 'm.' + c.trim()).join(', ')} FROM ${from}
    WHERE ${where.join(' AND ')} ORDER BY m.is_pinned DESC, ${SORTS[sort] || 'm.date DESC'} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 200), Number(offset) || 0);
  return rows.map(hydrate);
}

// Ribbon "Sort by" choices
const SORTS = {
  'date-asc': 'm.date ASC', from: 'LOWER(m.from_name) ASC, m.date DESC', subject: 'LOWER(m.subject) ASC, m.date DESC',
  size: 'm.size DESC', importance: "CASE m.importance WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END, m.date DESC",
  flag: 'm.is_flagged DESC, m.flag_due_at ASC, m.date DESC',
};

// Turn user input into a safe FTS5 query: each word becomes a quoted prefix term.
export function ftsQuery(q) {
  const terms = (String(q).match(/[\p{L}\p{N}@._-]+/gu) || []).slice(0, 10).map((t) => t.replace(/["']/g, '').toLowerCase()).filter(Boolean);
  if (db.dialect === 'postgres') return terms.length ? terms.map((t) => `'${t}':*`).join(' & ') : "''";
  if (!terms.length) return '""';
  return terms.map((t) => `"${t}"*`).join(' ');
}
// Full-text match on the messages_fts table aliased as f
export const FTS_MATCH = db.dialect === 'postgres' ? "f.tsv @@ to_tsquery('simple', ?)" : 'messages_fts MATCH ?';
const FTS_ORDER = db.dialect === 'postgres' ? 'm.date DESC' : 'bm25(messages_fts), m.date DESC';

export function getMessage(userId, id, { inlineData = false } = {}) {
  const m = db.prepare('SELECT * FROM messages WHERE user_id = ? AND id = ?').get(userId, Number(id));
  if (!m) return null;
  const out = hydrate(m);
  out.calendar = m.calendar_json ? JSON.parse(m.calendar_json) : null;
  if (out.calendar?.eventId) {
    const ev = db.prepare('SELECT my_status, cancelled FROM events WHERE id = ? AND user_id = ?').get(out.calendar.eventId, userId);
    out.calendar.response = ev?.my_status || null;
    out.calendar.removed = !ev || !!ev.cancelled;
  }
  delete out.calendar_json;
  delete out.raw_path;
  const atts = db.prepare('SELECT id, filename, content_type, size, content_id FROM attachments WHERE message_id = ?').all(m.id);
  // Inline pictures (cid:) point at the attachment download and are not listed as files
  if (out.html_body && /cid:/i.test(out.html_body)) {
    for (const a of atts) {
      const cid = String(a.content_id || '').replace(/^<|>$/g, '');
      if (!cid) continue;
      const re = new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
      if (!re.test(out.html_body)) continue;
      let src = `/api/attachments/${a.id}?inline=1`;
      // The phone app cannot send its session with pictures, so it gets them embedded
      if (inlineData && /^image\//i.test(a.content_type) && a.size <= 2 * 1024 * 1024) {
        const bytes = blobs.get(db.prepare('SELECT storage_path FROM attachments WHERE id = ?').get(a.id).storage_path);
        if (bytes) src = `data:${a.content_type};base64,${bytes.toString('base64')}`;
      }
      out.html_body = out.html_body.replace(re, src);
      a.inline = true;
    }
  }
  out.attachments = atts.map(({ content_id, ...a }) => a);
  return out;
}

export function getThread(userId, threadId) {
  return db.prepare(`SELECT * FROM messages m WHERE user_id = ? AND thread_id = ? AND ${NOT_HELD} ORDER BY date ASC`).all(userId, threadId).map(hydrate);
}

export function getAttachment(userId, attId) {
  return db.prepare(`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = ? AND m.user_id = ?`).get(Number(attId), userId);
}

export function updateMessage(userId, id, patch) {
  const m = db.prepare('SELECT id FROM messages WHERE user_id = ? AND id = ?').get(userId, Number(id));
  if (!m) return null;
  const sets = [];
  const args = [];
  const flag = (k, col) => { if (k in patch) { sets.push(`${col} = ?`); args.push(patch[k] ? 1 : 0); } };
  flag('is_read', 'is_read'); flag('is_flagged', 'is_flagged'); flag('is_pinned', 'is_pinned'); flag('is_focused', 'is_focused');
  if (Array.isArray(patch.categories)) { sets.push('categories_json = ?'); args.push(JSON.stringify(patch.categories.map(String).slice(0, 10))); }
  if ('snooze_until' in patch) { sets.push('snooze_until = ?'); args.push(patch.snooze_until ? new Date(patch.snooze_until).toISOString() : null); }
  if (patch.folder_id) {
    const f = folderById(userId, patch.folder_id);
    if (!f) throw Object.assign(new Error('Folder not found.'), { status: 404 });
    sets.push('folder_id = ?'); args.push(f.id);
  }
  if (sets.length) db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...args, m.id);
  return getMessage(userId, id);
}

export function deleteMessage(userId, id) {
  const m = db.prepare('SELECT id, folder_id FROM messages WHERE user_id = ? AND id = ?').get(userId, Number(id));
  if (!m) return false;
  const trash = folderByRole(userId, 'trash');
  if (m.folder_id !== trash.id) {
    db.prepare('UPDATE messages SET folder_id = ? WHERE id = ?').run(trash.id, m.id);
  } else {
    // Permanent delete from Deleted Items
    purgeMessage(m.id);
  }
  return true;
}

/**
 * Remove a message, its search entry and its files for good. When the owner's
 * organization is on litigation hold the message is kept, hidden, for eDiscovery.
 */
export function purgeMessage(id, { force = false } = {}) {
  if (!force) {
    const hold = db.prepare('SELECT m.user_id FROM messages m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = u.org_id WHERE m.id = ? AND o.litigation_hold = 1').get(id);
    if (hold) {
      db.prepare('UPDATE messages SET folder_id = ? WHERE id = ?').run(recoverableFolder(hold.user_id).id, id);
      return;
    }
  }
  const atts = db.prepare('SELECT storage_path FROM attachments WHERE message_id = ?').all(id);
  const m = db.prepare('SELECT raw_path FROM messages WHERE id = ?').get(id);
  tx(() => {
    db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  });
  for (const a of atts) blobs.remove(a.storage_path);
  if (m?.raw_path) blobs.remove(m.raw_path);
}

export function saveAi(id, fields) {
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!['ai_priority', 'ai_category', 'ai_needs_reply', 'ai_summary', 'is_focused'].includes(k)) continue;
    sets.push(`${k} = ?`);
    args.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (sets.length) db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
}

const STOP = new Set('the a an and or of to in on for with about from what when where who whom which did does do is are was were be been have has had i me my we our you your it its this that these those any there their they them he she his her how why can could would should will please tell show find email emails mail message messages say said'.split(' '));

/** Full messages most relevant to a natural-language question (OR search ranked by bm25). */
export function searchForQuestion(userId, question, limit = 12) {
  const terms = (String(question).toLowerCase().match(/[\p{L}\p{N}@._-]+/gu) || []).filter((t) => t.length > 1 && !STOP.has(t)).slice(0, 12);
  if (!terms.length) return [];
  if (db.dialect === 'postgres') {
    const pq = terms.map((t) => `'${t.replace(/["']/g, '')}':*`).join(' | ');
    return db.prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
      WHERE ${FTS_MATCH} AND m.user_id = ? AND ${NOT_HELD} ORDER BY ts_rank(f.tsv, to_tsquery('simple', ?)) DESC, m.date DESC LIMIT ?`).all(pq, userId, pq, limit).map(hydrate);
  }
  const q = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
  return db.prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
    WHERE ${FTS_MATCH} AND m.user_id = ? AND ${NOT_HELD} ORDER BY ${FTS_ORDER} LIMIT ?`).all(q, userId, limit).map(hydrate);
}

/** Save the original MIME for a message that has none yet (used by IMAP). */
export function saveRaw(id, raw) {
  const rawPath = blobs.put('raw', `${id}-${crypto.randomUUID()}.eml`, raw);
  db.prepare('UPDATE messages SET raw_path = ? WHERE id = ?').run(rawPath, id);
  return rawPath;
}

/** Copy a message into another folder of the same mailbox (IMAP COPY). Returns the new id. */
export function copyMessage(userId, id, folderId) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?').get(Number(id), userId);
  const f = folderById(userId, folderId);
  if (!m || !f) return null;
  const skip = new Set(['id', 'folder_id', 'imap_uid', 'imap_deleted', 'raw_path', 'created_at']);
  const cols = Object.keys(m).filter((c) => !skip.has(c));
  return tx(() => {
    const r = db.prepare(`INSERT INTO messages (folder_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(f.id, ...cols.map((c) => m[c]));
    const nid = Number(r.lastInsertRowid);
    const rawData = m.raw_path ? blobs.get(m.raw_path) : null;
    if (rawData) saveRaw(nid, rawData);
    for (const a of db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(m.id)) {
      const storage = blobs.copy(a.storage_path, 'attachments', `${nid}-${crypto.randomUUID()}`);
      db.prepare('INSERT INTO attachments (message_id, filename, content_type, size, storage_path, content_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(nid, a.filename, a.content_type, a.size, storage, a.content_id);
    }
    db.prepare('INSERT INTO messages_fts (rowid, subject, body, people) SELECT ?, subject, body, people FROM messages_fts WHERE rowid = ?').run(nid, m.id);
    return nid;
  });
}
