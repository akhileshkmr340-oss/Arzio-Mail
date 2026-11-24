// Calendar, To Do, notifications, app passwords and API tokens.
import express from 'express';
import { useAi } from '../billing.js';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { httpError, createApiToken, createAppPassword } from '../auth.js';
import * as cal from '../calendar/service.js';
import * as eas from '../eas/index.js';
import * as push from '../push.js';
import * as store from '../mail/store.js';
import * as ai from '../ai/index.js';
import { audit } from '../audit.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------ public: calendar feed (secret URL)
export const calendarPublic = express.Router();
calendarPublic.get('/calendar/feed/:token.ics', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE calendar_feed_token = ? AND is_disabled = 0').get(String(req.params.token));
  if (!u || !req.params.token) return res.status(404).send('Not found');
  res.type('text/calendar; charset=utf-8').send(cal.feedIcs(u.id));
});

export const calendar = express.Router();

function range(req) {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 86400e3);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 42 * 86400e3);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw httpError(400, 'Invalid date range.');
  if (to - from > 400 * 86400e3) throw httpError(400, 'Date range is too long.');
  return { from: from.toISOString(), to: to.toISOString() };
}

// ------------------------------------------------------------ events
calendar.get('/calendar/events', wrap(async (req, res) => {
  const { from, to } = range(req);
  res.json({ events: cal.listEvents(req.user.id, from, to) });
}));

calendar.get('/calendar/events/:id', (req, res) => {
  const e = cal.getEvent(req.user.id, req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  res.json({ event: e });
});

calendar.post('/calendar/events', wrap(async (req, res) => {
  const e = await cal.createEvent(req.user, req.body || {});
  audit(req.user.id, 'calendar.create', { eventId: e.id, attendees: e.attendees.length });
  res.status(201).json({ event: e });
}));

calendar.put('/calendar/events/:id', wrap(async (req, res) => {
  res.json({ event: await cal.updateEvent(req.user, req.params.id, req.body || {}) });
}));

calendar.delete('/calendar/events/:id', wrap(async (req, res) => {
  await cal.deleteEvent(req.user, req.params.id, { notify: req.query.notify !== '0' });
  res.json({ ok: true });
}));

calendar.post('/calendar/events/:id/respond', wrap(async (req, res) => {
  const b = req.body || {};
  res.json({ event: await cal.respond(req.user, req.params.id, String(b.status || ''), { sendReply: b.sendReply !== false }) });
}));

// Scheduling assistant: busy times for people in your organization
calendar.post('/calendar/freebusy', wrap(async (req, res) => {
  const b = req.body || {};
  const from = new Date(b.from || Date.now());
  const to = new Date(b.to || from.getTime() + 86400e3);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to - from > 31 * 86400e3) throw httpError(400, 'Invalid date range.');
  const emails = (Array.isArray(b.emails) ? b.emails : String(b.emails || '').split(/[,;\s]+/)).filter(Boolean);
  res.json({ busy: cal.freeBusy(req.user, [req.user.email, ...emails], from.toISOString(), to.toISOString()) });
}));

calendar.post('/calendar/import', wrap(async (req, res) => {
  const text = String(req.body?.ics || '');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw httpError(400, 'That is not an .ics calendar file.');
  if (text.length > 5 * 1024 * 1024) throw httpError(413, 'Calendar file is too large.');
  res.json({ imported: cal.importIcs(req.user, text) });
}));

function feedUrl(req, token) {
  return token ? `${req.protocol}://${req.get('host')}/api/calendar/feed/${token}.ics` : null;
}
calendar.get('/calendar/feed', (req, res) => {
  const r = db.prepare('SELECT calendar_feed_token FROM users WHERE id = ?').get(req.user.id);
  res.json({ url: feedUrl(req, r.calendar_feed_token) });
});
calendar.post('/calendar/feed', (req, res) => {
  const token = req.body?.enabled === false ? null : crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE users SET calendar_feed_token = ? WHERE id = ?').run(token, req.user.id);
  audit(req.user.id, token ? 'calendar.feed.reset' : 'calendar.feed.off', {});
  res.json({ url: feedUrl(req, token) });
});

// AI meeting prep: related mail, open questions
calendar.post('/calendar/events/:id/brief', wrap(async (req, res) => {
  if (!req.user.ai_enabled) throw httpError(403, 'AI features are turned off in your settings.'); useAi(req.user);
  const e = cal.getEvent(req.user.id, req.params.id);
  if (!e) throw httpError(404, 'Event not found.');
  const people = e.attendees.map((a) => a.email).concat(e.organizer_email).filter((x) => x && x !== req.user.email);
  const sources = store.searchForQuestion(req.user.id, `${e.title} ${people.join(' ')}`, 8);
  const brief = await ai.meetingBrief({ event: { title: e.title, start: e.start_at, attendees: e.attendees, description: e.description }, sources });
  const byId = new Map(sources.map((m) => [m.id, m]));
  res.json({ ...brief, sources: (brief.citedIds || []).map((id) => byId.get(id)).filter(Boolean).map((m) => ({ id: m.id, subject: m.subject, from: m.from_name || m.from_addr, date: m.date })) });
}));

// ------------------------------------------------------------ To Do
function cleanTask(b, old = {}) {
  const date = (v, d) => (v === null || v === '' ? null : v !== undefined ? new Date(v).toISOString() : d ?? null);
  const title = String(b.title ?? old.title ?? '').trim().slice(0, 300);
  if (!title) throw httpError(400, 'Give the task a title.');
  return {
    title,
    notes: String(b.notes ?? old.notes ?? '').slice(0, 10000),
    list_name: String(b.list_name ?? old.list_name ?? 'Tasks').trim().slice(0, 60) || 'Tasks',
    due_at: date(b.due_at, old.due_at),
    reminder_at: date(b.reminder_at, old.reminder_at),
    important: (b.important ?? old.important) ? 1 : 0,
  };
}
const taskRow = (t) => (t ? { ...t, important: !!t.important, reminded: !!t.reminded, completed: !!t.completed_at } : t);

calendar.get('/tasks', (req, res) => {
  const where = ['user_id = ?'];
  const args = [req.user.id];
  if (req.query.list) { where.push('list_name = ?'); args.push(String(req.query.list)); }
  if (req.query.important === '1') where.push('important = 1');
  if (req.query.done === '0') where.push('completed_at IS NULL');
  const tasks = db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY completed_at IS NOT NULL, completed_at DESC, due_at IS NULL, due_at, id DESC LIMIT 1000`).all(...args).map(taskRow);
  const lists = db.prepare("SELECT list_name AS name, SUM(completed_at IS NULL) AS open FROM tasks WHERE user_id = ? GROUP BY list_name ORDER BY list_name = 'Tasks' DESC, list_name").all(req.user.id);
  // Flagged email shows up as tasks too, like Outlook
  const flagged = db.prepare('SELECT id, subject, from_name, from_addr, date FROM messages WHERE user_id = ? AND is_flagged = 1 ORDER BY date DESC LIMIT 200').all(req.user.id);
  res.json({ tasks, lists, flagged });
});

calendar.post('/tasks', wrap(async (req, res) => {
  const t = cleanTask(req.body || {});
  let messageId = null;
  if (req.body?.message_id) {
    const m = store.getMessage(req.user.id, req.body.message_id);
    if (!m) throw httpError(404, 'Message not found.');
    messageId = m.id;
  }
  const r = db.prepare('INSERT INTO tasks (user_id, title, notes, list_name, due_at, reminder_at, important, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, t.title, t.notes, t.list_name, t.due_at, t.reminder_at, t.important, messageId);
  res.status(201).json({ task: taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid)) });
}));

calendar.patch('/tasks/:id', wrap(async (req, res) => {
  const old = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!old) throw httpError(404, 'Task not found.');
  const b = req.body || {};
  const t = cleanTask(b, old);
  const completed = 'completed' in b ? (b.completed ? old.completed_at || new Date().toISOString() : null) : old.completed_at;
  const reminded = t.reminder_at !== old.reminder_at ? 0 : old.reminded;
  db.prepare('UPDATE tasks SET title = ?, notes = ?, list_name = ?, due_at = ?, reminder_at = ?, important = ?, completed_at = ?, reminded = ? WHERE id = ?')
    .run(t.title, t.notes, t.list_name, t.due_at, t.reminder_at, t.important, completed, reminded, old.id);
  res.json({ task: taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(old.id)) });
}));

calendar.delete('/tasks/:id', (req, res) => {
  const r = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Task not found.' });
  res.json({ ok: true });
});

// ------------------------------------------------------------ notifications (reminders)
calendar.get('/notifications', (req, res) => {
  const unread = req.query.unread === '1' ? 'AND is_read = 0' : '';
  const items = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ${unread} ORDER BY id DESC LIMIT 50`).all(req.user.id)
    .map((n) => ({ ...n, is_read: !!n.is_read, link: JSON.parse(n.link_json || '{}'), link_json: undefined }));
  res.json({ notifications: items });
});
calendar.post('/notifications/read', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null;
  if (ids?.length) db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).run(req.user.id, ...ids);
  else db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------ app passwords (IMAP/SMTP) and API tokens (API/MCP)
calendar.get('/me/app-passwords', (req, res) => {
  res.json({
    appPasswords: db.prepare('SELECT id, name, last_used, created_at FROM app_passwords WHERE user_id = ? ORDER BY id DESC').all(req.user.id),
    servers: {
      imap: { host: config.imap.publicHost, port: config.imap.port, security: config.imap.tls ? 'SSL/TLS' : 'None (development)' },
      smtp: { host: config.imap.publicHost, port: config.submission.port, security: config.submission.tls ? 'SSL/TLS' : 'None (development)' },
      exchange: { server: req.get('host'), url: `${req.protocol}://${req.get('host')}/Microsoft-Server-ActiveSync` },
      username: req.user.email,
    },
  });
});

// ------------------------------------------------------------ push notifications for the phone app
calendar.post('/me/push-tokens', (req, res) => {
  if (req.tokenScopes) return res.status(403).json({ error: 'API tokens cannot register phones.' });
  push.registerToken(req.user.id, { token: req.body?.token, platform: req.body?.platform, deviceName: req.body?.deviceName });
  res.status(201).json({ ok: true });
});
calendar.delete('/me/push-tokens', (req, res) => {
  push.removeToken(req.user.id, req.body?.token || req.query.token);
  res.json({ ok: true });
});

// ------------------------------------------------------------ phones connected with Exchange ActiveSync
calendar.get('/me/devices', (req, res) => res.json({ devices: eas.listDevices(req.user.id) }));
calendar.post('/me/devices/:id', (req, res) => {
  if (req.tokenScopes) return res.status(403).json({ error: 'API tokens cannot manage devices.' });
  const action = { block: 'blocked', allow: 'allowed', wipe: 'wipe', remove: 'remove' }[req.body?.action];
  if (!action) throw httpError(400, 'Choose block, allow, wipe or remove.');
  if (!eas.setDeviceStatus(req.user.id, req.params.id, action)) throw httpError(404, 'Device not found.');
  res.json({ ok: true, devices: eas.listDevices(req.user.id) });
});
calendar.post('/me/app-passwords', (req, res) => {
  if (req.tokenScopes) return res.status(403).json({ error: 'API tokens cannot create passwords.' });
  const n = db.prepare('SELECT COUNT(*) AS n FROM app_passwords WHERE user_id = ?').get(req.user.id).n;
  if (n >= 20) return res.status(400).json({ error: 'You have 20 app passwords. Remove one first.' });
  const p = createAppPassword(req.user.id, req.body?.name);
  audit(req.user.id, 'security.app_password.create', { id: p.id });
  res.status(201).json(p);
});
calendar.delete('/me/app-passwords/:id', (req, res) => {
  db.prepare('DELETE FROM app_passwords WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  audit(req.user.id, 'security.app_password.delete', { id: Number(req.params.id) });
  res.json({ ok: true });
});

calendar.get('/me/tokens', (req, res) => {
  res.json({ tokens: db.prepare('SELECT id, name, scopes, last_used, created_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC').all(req.user.id) });
});
calendar.post('/me/tokens', (req, res) => {
  if (req.tokenScopes) return res.status(403).json({ error: 'API tokens cannot create tokens.' });
  const n = db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').get(req.user.id).n;
  if (n >= 20) return res.status(400).json({ error: 'You have 20 tokens. Remove one first.' });
  const t = createApiToken(req.user.id, req.body?.name, req.body?.scopes);
  audit(req.user.id, 'security.token.create', { id: t.id, scopes: t.scopes });
  res.status(201).json(t);
});
calendar.delete('/me/tokens/:id', (req, res) => {
  db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  audit(req.user.id, 'security.token.delete', { id: Number(req.params.id) });
  res.json({ ok: true });
});
