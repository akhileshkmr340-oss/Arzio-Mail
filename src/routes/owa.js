// Outlook-on-the-web features: reactions, read receipts, Translator,
// appearance settings and shared calendars.
import express from 'express';
import { db } from '../db.js';
import { httpError, getUser, findUserByEmail } from '../auth.js';
import * as store from '../mail/store.js';
import * as ai from '../ai/index.js';
import * as cal from '../calendar/service.js';
import { performSend } from '../mail/delivery.js';
import { useAi } from '../billing.js';
import { audit } from '../audit.js';

db.exec(`
CREATE TABLE IF NOT EXISTS message_reactions (
  id INTEGER PRIMARY KEY,
  msg_key TEXT NOT NULL,                     -- the Message-ID header, shared by every copy
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(msg_key, user_id)
);
CREATE TABLE IF NOT EXISTS calendar_shares (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grantee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'view',         -- freebusy | view | edit
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_id, grantee_id)
);
`);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const owa = express.Router();

// ------------------------------------------------------------ reactions
export const REACTIONS = ['👍', '❤️', '🎉', '😆', '😮', '😢'];

function reactionsFor(userId, keys) {
  if (!keys.length) return {};
  const rows = db.prepare(`SELECT r.msg_key, r.emoji, r.user_id, u.name, u.email FROM message_reactions r JOIN users u ON u.id = r.user_id
    WHERE r.msg_key IN (${keys.map(() => '?').join(',')}) ORDER BY r.created_at`).all(...keys);
  const out = {};
  for (const r of rows) {
    const list = (out[r.msg_key] ||= []);
    let e = list.find((x) => x.emoji === r.emoji);
    if (!e) list.push(e = { emoji: r.emoji, count: 0, mine: false, names: [] });
    e.count += 1;
    e.names.push(r.name || r.email);
    if (r.user_id === userId) e.mine = true;
  }
  return out;
}

// Reactions are visible to everyone on this service who has the message
owa.post('/reactions/lookup', (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean).slice(0, 200);
  if (!ids.length) return res.json({ reactions: {} });
  const rows = db.prepare(`SELECT id, message_id FROM messages WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(req.mbx, ...ids);
  const byKey = reactionsFor(req.user.id, [...new Set(rows.map((r) => r.message_id).filter(Boolean))]);
  res.json({ reactions: Object.fromEntries(rows.map((r) => [r.id, byKey[r.message_id] || []])) });
});

owa.post('/messages/:id/reactions', (req, res) => {
  const m = store.getMessage(req.mbx, req.params.id);
  if (!m) throw httpError(404, 'Message not found.');
  if (!m.message_id) throw httpError(400, 'This message cannot take reactions.');
  const emoji = String(req.body?.emoji || '');
  if (emoji && !REACTIONS.includes(emoji)) throw httpError(400, 'Pick one of the offered reactions.');
  const mine = db.prepare('SELECT emoji FROM message_reactions WHERE msg_key = ? AND user_id = ?').get(m.message_id, req.user.id);
  db.prepare('DELETE FROM message_reactions WHERE msg_key = ? AND user_id = ?').run(m.message_id, req.user.id);
  if (emoji && mine?.emoji !== emoji) db.prepare('INSERT INTO message_reactions (msg_key, user_id, emoji) VALUES (?, ?, ?)').run(m.message_id, req.user.id, emoji);
  res.json({ reactions: reactionsFor(req.user.id, [m.message_id])[m.message_id] || [] });
});

// ------------------------------------------------------------ read receipts
owa.post('/messages/:id/receipt', wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE user_id = ? AND id = ?').get(req.mbx, Number(req.params.id));
  if (!row) throw httpError(404, 'Message not found.');
  const to = row.receipt_to;
  db.prepare('UPDATE messages SET receipt_to = NULL WHERE id = ?').run(row.id);
  if (to && req.body?.send) {
    const me = getUser(req.mbx);
    const sent = new Date(row.date).toUTCString();
    await performSend(req.user, {
      from: req.mbx !== req.user.id ? me.email : undefined,
      to, subject: `Read: ${row.subject || ''}`, noSignature: true,
      text: `Your message\n\n  To: ${me.name} <${me.email}>\n  Subject: ${row.subject || ''}\n  Sent: ${sent}\n\nwas read on ${new Date().toUTCString()}.`,
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  }
  res.json({ ok: true, sent: !!(to && req.body?.send) });
}));

// ------------------------------------------------------------ Translator
owa.post('/ai/translate', wrap(async (req, res) => {
  if (!req.user.ai_enabled) throw httpError(403, 'AI features are turned off in your settings.');
  const m = store.getMessage(req.mbx, req.body?.messageId);
  if (!m) throw httpError(404, 'Message not found.');
  const to = String(req.body?.to || 'English');
  useAi(req.user);
  const text = await ai.translate({ text: `${m.subject || ''}\n\n${m.text_body || store.htmlToText(m.html_body)}`, to });
  const [subject, ...rest] = String(text).split('\n');
  res.json({ subject: subject.trim(), text: rest.join('\n').trim(), to });
}));

// ------------------------------------------------------------ appearance and reading settings
const UI_KEYS = {
  theme: ['light', 'dark', 'system'],
  accent: ['blue', 'teal', 'green', 'purple', 'pink', 'orange', 'gray'],
  density: ['compact', 'comfortable', 'roomy'],
  readingPane: ['right', 'bottom', 'off'],
  textSize: ['small', 'medium', 'large'],
  shortcuts: ['outlook', 'gmail', 'off'],
};
owa.patch('/me/ui', (req, res) => {
  const cur = JSON.parse(db.prepare('SELECT ui_json FROM users WHERE id = ?').get(req.user.id).ui_json || '{}');
  const b = req.body || {};
  for (const [k, allowed] of Object.entries(UI_KEYS)) if (allowed.includes(b[k])) cur[k] = b[k];
  for (const k of ['conversations', 'senderImages', 'previewText', 'markReadOnOpen']) if (typeof b[k] === 'boolean') cur[k] = b[k];
  if (Array.isArray(b.favorites)) cur.favorites = b.favorites.map(String).filter((f) => /^(folder:\d+|smart:\w+|category:.{1,40})$/.test(f)).slice(0, 30);
  db.prepare('UPDATE users SET ui_json = ? WHERE id = ?').run(JSON.stringify(cur), req.user.id);
  res.json({ ui: cur });
});

// ------------------------------------------------------------ shared calendars
const ROLES = ['freebusy', 'view', 'edit'];

owa.get('/calendar/shares', (req, res) => {
  const given = db.prepare(`SELECT s.id, s.role, u.email, u.name FROM calendar_shares s JOIN users u ON u.id = s.grantee_id WHERE s.owner_id = ? ORDER BY u.name`).all(req.user.id);
  const received = db.prepare(`SELECT s.id, s.role, u.id AS owner_id, u.email, u.name FROM calendar_shares s JOIN users u ON u.id = s.owner_id WHERE s.grantee_id = ? AND u.is_disabled = 0 ORDER BY u.name`).all(req.user.id);
  res.json({ given, received });
});

owa.post('/calendar/shares', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'view';
  const who = findUserByEmail(email);
  if (!who || who.mailbox_type === 'shared') throw httpError(404, 'Calendars can be shared with people who have an address on this service.');
  if (who.id === req.user.id) throw httpError(400, 'That is your own address.');
  db.prepare(`INSERT INTO calendar_shares (owner_id, grantee_id, role) VALUES (?, ?, ?)
    ON CONFLICT(owner_id, grantee_id) DO UPDATE SET role = excluded.role`).run(req.user.id, who.id, role);
  audit(req.user.id, 'calendar.shared', { with: email, role });
  const what = { freebusy: 'when they are busy', view: 'all event details', edit: 'and edit their calendar' }[role];
  await performSend(req.user, {
    to: email, noSignature: true, subject: `${req.user.name} shared their calendar with you`,
    text: `${req.user.name} (${req.user.email}) shared their calendar with you. You can see ${what}.\n\nOpen Calendar in Arzio Mail: it is listed under "People's calendars".`,
  }).catch(() => {});
  res.status(201).json({ ok: true });
}));

owa.delete('/calendar/shares/:id', (req, res) => {
  db.prepare('DELETE FROM calendar_shares WHERE id = ? AND (owner_id = ? OR grantee_id = ?)').run(Number(req.params.id), req.user.id, req.user.id);
  res.json({ ok: true });
});

function shareOf(granteeId, ownerId) {
  return db.prepare('SELECT role FROM calendar_shares WHERE owner_id = ? AND grantee_id = ?').get(Number(ownerId), granteeId)?.role || null;
}

owa.get('/calendar/shared/:ownerId/events', (req, res) => {
  const role = shareOf(req.user.id, req.params.ownerId);
  if (!role) throw httpError(403, 'This calendar is not shared with you.');
  const from = new Date(String(req.query.from || Date.now() - 7 * 86400e3));
  const to = new Date(String(req.query.to || from.getTime() + 42 * 86400e3));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to - from > 400 * 86400e3) throw httpError(400, 'Invalid date range.');
  let events = cal.listEvents(Number(req.params.ownerId), from.toISOString(), to.toISOString()).filter((e) => e.show_as !== 'free' || role !== 'freebusy');
  if (role === 'freebusy') events = events.map((e) => ({ id: e.id, start_at: e.start_at, end_at: e.end_at, all_day: e.all_day, title: e.show_as === 'tentative' ? 'Tentative' : 'Busy', show_as: e.show_as, busy_only: true }));
  res.json({ role, events });
});

function editor(req) {
  if (shareOf(req.user.id, req.params.ownerId) !== 'edit') throw httpError(403, 'You can only view this calendar.');
  return getUser(Number(req.params.ownerId));
}
owa.post('/calendar/shared/:ownerId/events', wrap(async (req, res) => {
  const owner = editor(req);
  res.status(201).json({ event: await cal.createEvent(owner, req.body || {}) });
}));
owa.put('/calendar/shared/:ownerId/events/:id', wrap(async (req, res) => {
  const owner = editor(req);
  res.json({ event: await cal.updateEvent(owner, Number(req.params.id), req.body || {}) });
}));
owa.delete('/calendar/shared/:ownerId/events/:id', wrap(async (req, res) => {
  const owner = editor(req);
  await cal.deleteEvent(owner, Number(req.params.id));
  res.json({ ok: true });
}));
