// The Outlook-style ribbon: Ignore and Clean Up conversations, Follow Up dates,
// Quick Steps, contact groups, the address book, saving a message as a file
// and a weekly Insights summary.
import express from 'express';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { db } from '../db.js';
import { httpError } from '../auth.js';
import * as store from '../mail/store.js';
import * as blobs from '../blobs.js';

db.exec(`
CREATE TABLE IF NOT EXISTS ignored_threads (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, thread_id)
);
CREATE TABLE IF NOT EXISTS contact_lists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  members_json TEXT NOT NULL DEFAULT '[]',   -- [{email, name}]
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const ribbon = express.Router();

const own = (req) => {
  const m = db.prepare('SELECT * FROM messages WHERE user_id = ? AND id = ?').get(req.mbx, Number(req.params.id));
  if (!m) throw httpError(404, 'Message not found.');
  return m;
};

// ------------------------------------------------------------ Ignore conversation
// Everything in the conversation goes to Deleted Items, and so does every later reply.
export function isIgnored(userId, threadId) {
  return !!db.prepare('SELECT 1 FROM ignored_threads WHERE user_id = ? AND thread_id = ?').get(userId, threadId);
}
ribbon.post('/messages/:id/ignore', wrap(async (req, res) => {
  const m = own(req);
  const on = req.body?.ignore !== false;
  let moved = 0;
  if (on) {
    db.prepare('INSERT OR IGNORE INTO ignored_threads (user_id, thread_id, subject) VALUES (?, ?, ?)').run(req.mbx, m.thread_id, m.subject);
    const trash = store.folderByRole(req.mbx, 'trash').id;
    const sent = store.folderByRole(req.mbx, 'sent').id;
    moved = db.prepare('UPDATE messages SET folder_id = ? WHERE user_id = ? AND thread_id = ? AND folder_id NOT IN (?, ?)').run(trash, req.mbx, m.thread_id, trash, sent).changes;
  } else {
    db.prepare('DELETE FROM ignored_threads WHERE user_id = ? AND thread_id = ?').run(req.mbx, m.thread_id);
    const inbox = store.folderByRole(req.mbx, 'inbox').id;
    const trash = store.folderByRole(req.mbx, 'trash').id;
    moved = db.prepare('UPDATE messages SET folder_id = ? WHERE user_id = ? AND thread_id = ? AND folder_id = ?').run(inbox, req.mbx, m.thread_id, trash).changes;
  }
  res.json({ ignored: on, moved });
}));

// ------------------------------------------------------------ Clean Up
// A message is redundant when a later message in the same conversation quotes all of it.
const norm = (t) => String(t || '').replace(/^>+ ?/gm, '').replace(/\s+/g, ' ').trim().toLowerCase();
function redundantIn(userId, threadId) {
  const msgs = db.prepare(`SELECT m.id, m.text_body, m.folder_id, m.is_flagged, m.is_pinned FROM messages m
    WHERE m.user_id = ? AND m.thread_id = ? AND m.folder_id NOT IN (SELECT id FROM folders WHERE user_id = m.user_id AND role IN ('trash', 'sent', 'drafts', 'recoverable'))
    ORDER BY m.date ASC`).all(userId, threadId);
  const out = [];
  msgs.forEach((m, i) => {
    if (m.is_flagged || m.is_pinned) return;
    const body = norm(m.text_body);
    if (body.length < 20) return;
    const probe = body.slice(0, 400);
    if (msgs.slice(i + 1).some((later) => norm(later.text_body).includes(probe))) out.push(m.id);
  });
  return out;
}
function cleanUp(userId, ids) {
  const trash = store.folderByRole(userId, 'trash').id;
  for (const id of ids) db.prepare('UPDATE messages SET folder_id = ? WHERE id = ? AND user_id = ?').run(trash, id, userId);
  return ids.length;
}
ribbon.post('/messages/:id/cleanup', wrap(async (req, res) => {
  const m = own(req);
  res.json({ removed: cleanUp(req.mbx, redundantIn(req.mbx, m.thread_id)) });
}));
ribbon.post('/folders/:id/cleanup', wrap(async (req, res) => {
  const f = db.prepare('SELECT id FROM folders WHERE user_id = ? AND id = ?').get(req.mbx, Number(req.params.id));
  if (!f) throw httpError(404, 'Folder not found.');
  const threads = db.prepare('SELECT DISTINCT thread_id FROM messages WHERE user_id = ? AND folder_id = ?').all(req.mbx, f.id);
  let removed = 0;
  for (const t of threads) removed += cleanUp(req.mbx, redundantIn(req.mbx, t.thread_id));
  res.json({ removed });
}));

// ------------------------------------------------------------ Follow Up
// state: flagged (with an optional due date) | complete | clear
ribbon.post('/messages/:id/followup', wrap(async (req, res) => {
  const m = own(req);
  const { state = 'flagged', due_at } = req.body || {};
  if (state === 'flagged') {
    const due = due_at ? new Date(due_at) : null;
    if (due && Number.isNaN(due.getTime())) throw httpError(400, 'That date is not valid.');
    db.prepare('UPDATE messages SET is_flagged = 1, flag_due_at = ?, flag_completed_at = NULL WHERE id = ?').run(due ? due.toISOString() : null, m.id);
  } else if (state === 'complete') {
    db.prepare('UPDATE messages SET is_flagged = 0, flag_completed_at = ? WHERE id = ?').run(new Date().toISOString(), m.id);
  } else if (state === 'clear') {
    db.prepare('UPDATE messages SET is_flagged = 0, flag_due_at = NULL, flag_completed_at = NULL WHERE id = ?').run(m.id);
  } else throw httpError(400, 'Unknown follow-up state.');
  res.json({ message: store.getMessage(req.mbx, m.id) });
}));

// ------------------------------------------------------------ Quick Steps
const STEP_TYPES = ['move', 'archive', 'delete', 'read', 'unread', 'flag', 'pin', 'category', 'forward', 'reply', 'replyall', 'newmail'];
export const DEFAULT_QUICK_STEPS = [
  { name: 'Move to: ?', icon: 'move', actions: [{ type: 'read' }, { type: 'move', value: null }] },
  { name: 'To Manager', icon: 'forward', actions: [{ type: 'forward', value: null }] },
  { name: 'Team Email', icon: 'mail', actions: [{ type: 'newmail', value: null }] },
  { name: 'Done', icon: 'check', actions: [{ type: 'read' }, { type: 'archive' }] },
  { name: 'Reply & Delete', icon: 'reply', actions: [{ type: 'reply' }, { type: 'delete' }] },
];
function cleanSteps(list) {
  if (!Array.isArray(list)) throw httpError(400, 'Quick Steps must be a list.');
  return list.slice(0, 20).map((s) => {
    const name = String(s?.name || '').trim().slice(0, 60);
    if (!name) throw httpError(400, 'Give each Quick Step a name.');
    const actions = (Array.isArray(s.actions) ? s.actions : []).filter((a) => STEP_TYPES.includes(a?.type)).slice(0, 6)
      .map((a) => ({ type: a.type, value: a.value === null || a.value === undefined || a.value === '' ? null : String(a.value).slice(0, 500) }));
    if (!actions.length) throw httpError(400, `"${name}" needs at least one action.`);
    return { name, icon: /^[a-z]{1,20}$/.test(s.icon || '') ? s.icon : 'bolt', actions };
  });
}
ribbon.get('/me/quick-steps', (req, res) => {
  const row = db.prepare('SELECT quick_steps_json FROM users WHERE id = ?').get(req.user.id);
  res.json({ steps: row?.quick_steps_json ? JSON.parse(row.quick_steps_json) : DEFAULT_QUICK_STEPS });
});
ribbon.put('/me/quick-steps', wrap(async (req, res) => {
  const steps = req.body?.reset ? DEFAULT_QUICK_STEPS : cleanSteps(req.body?.steps);
  db.prepare('UPDATE users SET quick_steps_json = ? WHERE id = ?').run(req.body?.reset ? null : JSON.stringify(steps), req.user.id);
  res.json({ steps });
}));

// ------------------------------------------------------------ contact groups and the address book
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function listOut(l) { return { id: l.id, name: l.name, description: l.description, members: JSON.parse(l.members_json || '[]') }; }
function cleanList(b) {
  const name = String(b?.name || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'Give the group a name.');
  const seen = new Set();
  const members = (Array.isArray(b.members) ? b.members : []).map((m) => (typeof m === 'string' ? { email: m } : m))
    .map((m) => ({ email: String(m?.email || '').trim().toLowerCase(), name: String(m?.name || '').trim().slice(0, 120) }))
    .filter((m) => EMAIL.test(m.email) && !seen.has(m.email) && seen.add(m.email)).slice(0, 500);
  if (!members.length) throw httpError(400, 'Add at least one member with an email address.');
  return { name, description: String(b.description || '').slice(0, 500), members };
}
ribbon.get('/contact-lists', (req, res) => {
  res.json({ lists: db.prepare('SELECT * FROM contact_lists WHERE user_id = ? ORDER BY name').all(req.user.id).map(listOut) });
});
ribbon.post('/contact-lists', wrap(async (req, res) => {
  const l = cleanList(req.body);
  const id = db.prepare('INSERT INTO contact_lists (user_id, name, description, members_json) VALUES (?, ?, ?, ?)').run(req.user.id, l.name, l.description, JSON.stringify(l.members)).lastInsertRowid;
  res.status(201).json({ list: listOut(db.prepare('SELECT * FROM contact_lists WHERE id = ?').get(Number(id))) });
}));
ribbon.put('/contact-lists/:id', wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM contact_lists WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!row) throw httpError(404, 'Group not found.');
  const l = cleanList(req.body);
  db.prepare('UPDATE contact_lists SET name = ?, description = ?, members_json = ? WHERE id = ?').run(l.name, l.description, JSON.stringify(l.members), row.id);
  res.json({ list: listOut(db.prepare('SELECT * FROM contact_lists WHERE id = ?').get(row.id)) });
}));
ribbon.delete('/contact-lists/:id', (req, res) => {
  const r = db.prepare('DELETE FROM contact_lists WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Group not found.' });
  res.json({ ok: true });
});

// Browse Groups: your own contact groups plus your organization's groups
ribbon.get('/groups/directory', (req, res) => {
  const orgId = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.user.id)?.org_id;
  const org = orgId ? db.prepare(`SELECT g.id, g.name, g.address, g.description,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = ?) AS is_member
    FROM groups g WHERE g.org_id = ? ORDER BY g.name`).all(req.user.id, orgId).map((g) => ({ ...g, is_member: !!g.is_member })) : [];
  const lists = db.prepare('SELECT * FROM contact_lists WHERE user_id = ? ORDER BY name').all(req.user.id).map(listOut);
  res.json({ org, lists });
});

// Address Book: saved contacts, people in your organization and your groups
ribbon.get('/address-book', (req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const me = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.user.id);
  const contacts = db.prepare(`SELECT email, name, company, job_title, phone FROM contacts WHERE user_id = ? AND is_saved = 1
    AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(company) LIKE ?) ORDER BY name, email LIMIT 300`).all(req.user.id, q, q, q);
  const directory = me?.org_id ? db.prepare(`SELECT email, name FROM users WHERE org_id = ? AND id <> ? AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?)
    ORDER BY name LIMIT 300`).all(me.org_id, req.user.id, q, q) : [];
  const orgGroups = me?.org_id ? db.prepare('SELECT name, address AS email FROM groups WHERE org_id = ? AND (LOWER(name) LIKE ? OR LOWER(address) LIKE ?) ORDER BY name').all(me.org_id, q, q) : [];
  const lists = db.prepare('SELECT * FROM contact_lists WHERE user_id = ? AND LOWER(name) LIKE ? ORDER BY name').all(req.user.id, q).map(listOut);
  res.json({ contacts, directory, groups: orgGroups, lists });
});

// ------------------------------------------------------------ Save as file (.eml)
export async function messageEml(userId, id) {
  const m = db.prepare('SELECT * FROM messages WHERE user_id = ? AND id = ?').get(userId, Number(id));
  if (!m) return null;
  const raw = m.raw_path ? blobs.get(m.raw_path) : null;
  if (raw) return { message: m, raw };
  const fmt = (list) => JSON.parse(list || '[]').map((p) => (p.name ? `"${p.name.replace(/"/g, '')}" <${p.address}>` : p.address)).join(', ');
  const attachments = db.prepare('SELECT filename, content_type, storage_path FROM attachments WHERE message_id = ?').all(m.id)
    .map((a) => ({ filename: a.filename, contentType: a.content_type, content: blobs.get(a.storage_path) || Buffer.alloc(0) }));
  const built = await new MailComposer({
    from: m.from_name ? `"${m.from_name.replace(/"/g, '')}" <${m.from_addr}>` : m.from_addr,
    to: fmt(m.to_json) || undefined, cc: fmt(m.cc_json) || undefined, subject: m.subject, date: new Date(m.date),
    messageId: m.message_id || undefined, text: m.text_body, html: m.html_body || undefined, attachments,
  }).compile().build();
  return { message: m, raw: built };
}
const safeName = (s) => (String(s || 'message').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || 'message');
ribbon.get('/messages/:id/eml', wrap(async (req, res) => {
  const out = await messageEml(req.mbx, req.params.id);
  if (!out) throw httpError(404, 'Message not found.');
  res.setHeader('Content-Type', 'message/rfc822');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName(out.message.subject)}.eml`)}`);
  res.send(out.raw);
}));

// ------------------------------------------------------------ Insights
ribbon.get('/insights', (req, res) => {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400e3).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 86400e3).toISOString();
  const roles = Object.fromEntries(db.prepare('SELECT role, id FROM folders WHERE user_id = ? AND role IS NOT NULL').all(req.mbx).map((f) => [f.role, f.id]));
  const count = (sql, ...a) => Number(db.prepare(sql).get(...a)?.n || 0);
  const received = count('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND folder_id <> ? AND folder_id <> ? AND date >= ?', req.mbx, roles.sent ?? -1, roles.drafts ?? -1, weekAgo);
  const sent = count('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND folder_id = ? AND date >= ?', req.mbx, roles.sent ?? -1, weekAgo);
  const unread = count('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND folder_id = ? AND is_read = 0', req.mbx, roles.inbox ?? -1);
  const flagged = count('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND is_flagged = 1', req.mbx);
  const overdue = count('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND is_flagged = 1 AND flag_due_at IS NOT NULL AND flag_due_at < ?', req.mbx, now.toISOString());
  const needsReply = count('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND folder_id = ? AND ai_needs_reply = 1 AND date >= ?', req.mbx, roles.inbox ?? -1, weekAgo);
  const topSenders = db.prepare(`SELECT from_addr AS email, MAX(from_name) AS name, COUNT(*) AS n FROM messages
    WHERE user_id = ? AND folder_id = ? AND date >= ? AND from_addr <> '' GROUP BY from_addr ORDER BY n DESC LIMIT 5`).all(req.mbx, roles.inbox ?? -1, monthAgo);
  const weekStart = new Date(now); weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400e3);
  const events = db.prepare(`SELECT start_at, end_at, attendees_json FROM events WHERE user_id = ? AND cancelled = 0 AND all_day = 0
    AND my_status <> 'declined' AND start_at < ? AND end_at > ?`).all(req.user.id, weekEnd.toISOString(), weekStart.toISOString());
  const meetingHours = events.reduce((h, e) => h + Math.max(0, (new Date(e.end_at) - new Date(e.start_at)) / 3600e3), 0);
  res.json({
    week: { received, sent, unread, flagged, overdue, needsReply },
    meetings: { count: events.length, hours: Math.round(meetingHours * 10) / 10, focusHours: Math.max(0, Math.round((40 - meetingHours) * 10) / 10) },
    topSenders,
  });
});
