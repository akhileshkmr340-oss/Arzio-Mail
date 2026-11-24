// REST API used by the web client (and future mobile apps / integrations).
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { config } from '../config.js';
import { db, tx } from '../db.js';
import {
  createUser, login, destroySession, sessionCookie, requireAuth, requireAdmin, requireOrgAdmin, parseCookies, COOKIE,
  getUser, hashPassword, verifyPassword, validatePassword, httpError,
} from '../auth.js';
import * as store from '../mail/store.js';
import { sendMail, deliverRaw, parseRecipients } from '../mail/delivery.js';
import * as ai from '../ai/index.js';
import { audit } from '../audit.js';
import { features } from './features.js';
import { calendar, calendarPublic } from './calendar.js';

export const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------ rate limiting
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n += 1;
  buckets.set(key, b);
  if (b.n > max) throw httpError(429, 'Too many attempts. Please wait and try again.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60e3).unref();

// ------------------------------------------------------------ service + auth
api.get('/service', (req, res) => {
  res.json({ name: config.serviceName, domain: config.primaryDomain, signupOpen: config.signup.open, ai: ai.aiInfo() });
});

api.post('/auth/signup', wrap(async (req, res) => {
  if (!config.signup.open) throw httpError(403, 'Sign-up is closed.');
  rateLimit(`signup:${req.ip}`, config.signup.perIpPerHour, 3600e3);
  const { username, name, password } = req.body || {};
  const user = createUser({ username, name, password, ip: req.ip });
  const s = login(user.email, password);
  res.setHeader('Set-Cookie', sessionCookie(s.token, s.expires));
  res.status(201).json({ user });
}));

api.post('/auth/login', wrap(async (req, res) => {
  const { email, password, code } = req.body || {};
  rateLimit(`login:${req.ip}`, 20, 15 * 60e3);
  rateLimit(`login-acct:${String(email).toLowerCase()}`, 10, 15 * 60e3);
  const s = login(email, password, code);
  audit(s.userId, 'auth.login', { ip: req.ip });
  res.setHeader('Set-Cookie', sessionCookie(s.token, s.expires));
  res.json({ ok: true });
}));

api.post('/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) destroySession(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// ------------------------------------------------------------ inbound webhooks
// For providers that receive mail and POST it to us (Postmark inbound, SES via
// S3/SNS forwarder, or any relay). Protected by INBOUND_WEBHOOK_SECRET.
function checkWebhook(req) {
  const secret = config.inbound.webhookSecret;
  const given = String(req.headers['x-arzio-secret'] || req.query.secret || '');
  if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    throw httpError(401, 'Bad webhook secret.');
  }
}

api.post('/inbound/raw', express.raw({ type: '*/*', limit: config.quotas.maxMessageBytes }), wrap(async (req, res) => {
  checkWebhook(req);
  const rcpts = String(req.query.rcpt || req.headers['x-arzio-rcpt'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!rcpts.length) throw httpError(400, 'Pass recipients in ?rcpt= or X-Arzio-Rcpt.');
  const delivered = await deliverRaw(Buffer.from(req.body), rcpts);
  res.json({ delivered });
}));

api.post('/inbound/postmark', express.json({ limit: '40mb' }), wrap(async (req, res) => {
  checkWebhook(req);
  const b = req.body || {};
  if (!b.RawEmail) throw httpError(400, 'Enable "Include raw email content" on the Postmark inbound stream.');
  const rcpts = [b.OriginalRecipient, ...(b.ToFull || []).map((x) => x.Email), ...(b.CcFull || []).map((x) => x.Email)].filter(Boolean);
  const delivered = await deliverRaw(Buffer.from(b.RawEmail), rcpts);
  res.json({ delivered });
}));

api.use(calendarPublic);

// Everything below requires a signed-in user
api.use(requireAuth);

// Which mailbox is this request about? Your own by default; a shared or
// delegated mailbox when X-Arzio-Mailbox names one you have access to.
api.use((req, res, next) => {
  req.mbx = req.user.id;
  const target = Number(req.headers['x-arzio-mailbox'] || 0);
  if (target && target !== req.user.id) {
    const d = db.prepare('SELECT permission FROM delegates WHERE owner_id = ? AND delegate_id = ?').get(target, req.user.id);
    if (!d) return res.status(403).json({ error: 'You do not have access to that mailbox.' });
    if (d.permission === 'read' && req.method !== 'GET') return res.status(403).json({ error: 'You have read-only access to that mailbox.' });
    req.mbx = target;
  }
  next();
});

api.get('/me', (req, res) => {
  res.json({ user: req.user, usage: { bytes: store.mailboxUsage(req.user.id), quota: config.quotas.mailboxBytes } });
});

api.patch('/me', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(b.name.trim().slice(0, 100), req.user.id);
  if (typeof b.signature === 'string') db.prepare('UPDATE users SET signature = ? WHERE id = ?').run(b.signature.slice(0, 2000), req.user.id);
  if (typeof b.ai_enabled === 'boolean') db.prepare('UPDATE users SET ai_enabled = ? WHERE id = ?').run(b.ai_enabled ? 1 : 0, req.user.id);
  if (b.newPassword) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(b.currentPassword || ''), row.password_hash)) throw httpError(400, 'Current password is wrong.');
    const err = validatePassword(b.newPassword);
    if (err) throw httpError(400, err);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.newPassword), req.user.id);
  }
  res.json({ user: getUser(req.user.id) });
}));

// ------------------------------------------------------------ folders
api.get('/folders', (req, res) => res.json({ folders: store.listFolders(req.mbx) }));
api.post('/folders', wrap(async (req, res) => res.status(201).json({ folder: store.createFolder(req.mbx, req.body?.name) })));
api.patch('/folders/:id', wrap(async (req, res) => res.json({ folder: store.renameFolder(req.mbx, req.params.id, req.body?.name) })));
api.delete('/folders/:id', wrap(async (req, res) => { store.deleteFolder(req.mbx, req.params.id); res.json({ ok: true }); }));

// ------------------------------------------------------------ messages
api.get('/messages', (req, res) => {
  const { folder, focus, q, offset, limit, flagged, snoozed, category, unread } = req.query;
  res.json({ messages: store.listMessages(req.mbx, { folderId: folder, focus, q, offset, limit, flagged: flagged === '1', snoozed: snoozed === '1', category, unread: unread === '1' }) });
});

api.get('/messages/:id', (req, res) => {
  const m = store.getMessage(req.mbx, req.params.id);
  if (!m) return res.status(404).json({ error: 'Message not found.' });
  if (!m.is_read) { store.updateMessage(req.mbx, m.id, { is_read: true }); m.is_read = true; }
  res.json({ message: m });
});

api.get('/threads/:threadId', (req, res) => {
  const messages = store.getThread(req.mbx, req.params.threadId);
  res.json({ messages: messages.map((m) => ({ ...m, attachments: db.prepare('SELECT id, filename, content_type, size FROM attachments WHERE message_id = ?').all(m.id) })) });
});

api.patch('/messages/:id', wrap(async (req, res) => {
  const m = store.updateMessage(req.mbx, req.params.id, req.body || {});
  if (!m) return res.status(404).json({ error: 'Message not found.' });
  res.json({ message: m });
}));

api.delete('/messages/:id', (req, res) => {
  if (!store.deleteMessage(req.mbx, req.params.id)) return res.status(404).json({ error: 'Message not found.' });
  res.json({ ok: true });
});

// Bulk actions: read, unread, flag, unflag, delete, move (folder_id), archive, junk
api.post('/messages/bulk', wrap(async (req, res) => {
  const { ids = [], action, folder_id } = req.body || {};
  const roleFolder = (role) => store.folderByRole(req.mbx, role).id;
  for (const id of ids.slice(0, 500)) {
    if (action === 'delete') store.deleteMessage(req.mbx, id);
    else if (action === 'read') store.updateMessage(req.mbx, id, { is_read: true });
    else if (action === 'unread') store.updateMessage(req.mbx, id, { is_read: false });
    else if (action === 'flag') store.updateMessage(req.mbx, id, { is_flagged: true });
    else if (action === 'unflag') store.updateMessage(req.mbx, id, { is_flagged: false });
    else if (action === 'archive') store.updateMessage(req.mbx, id, { folder_id: roleFolder('archive') });
    else if (action === 'junk') store.updateMessage(req.mbx, id, { folder_id: roleFolder('junk') });
    else if (action === 'move') store.updateMessage(req.mbx, id, { folder_id });
    else throw httpError(400, 'Unknown action.');
  }
  res.json({ ok: true });
}));

api.get('/attachments/:id', (req, res) => {
  const a = store.getAttachment(req.mbx, req.params.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found.' });
  res.setHeader('Content-Type', a.content_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(a.storage_path).pipe(res);
});

// ------------------------------------------------------------ compose
api.post('/send', wrap(async (req, res) => {
  const body = { ...(req.body || {}) };
  if (req.mbx !== req.user.id && !body.from) body.from = db.prepare('SELECT email FROM users WHERE id = ?').get(req.mbx).email;
  res.json(await sendMail(req.user, body));
}));

// Save (create or replace) a draft
api.post('/drafts', wrap(async (req, res) => {
  const b = req.body || {};
  const safe = (v) => { try { return parseRecipients(v); } catch { return []; } };
  if (b.id) {
    const old = store.getMessage(req.user.id, b.id);
    if (old && old.folder_id === store.folderByRole(req.user.id, 'drafts').id) { store.deleteMessage(req.user.id, old.id); store.deleteMessage(req.user.id, old.id); }
  }
  const id = store.storeMessage(req.user.id, {
    folderRole: 'drafts', from: { address: req.user.email, name: req.user.name },
    to: safe(b.to), cc: safe(b.cc), bcc: safe(b.bcc), subject: b.subject || '', text: b.text || '', isRead: true,
    inReplyTo: b.inReplyTo, refs: b.references,
  });
  res.json({ id });
}));

// ------------------------------------------------------------ AI assist
function requireAi(req) {
  if (!req.user.ai_enabled) throw httpError(403, 'AI features are turned off in your settings.');
  rateLimit(`ai:${req.user.id}`, 60, 3600e3);
}

api.post('/ai/summarize', wrap(async (req, res) => {
  requireAi(req);
  const m = store.getMessage(req.mbx, req.body?.messageId);
  if (!m) throw httpError(404, 'Message not found.');
  const messages = req.body?.thread === false ? [m] : store.getThread(req.mbx, m.thread_id);
  const result = await ai.summarize(messages);
  store.saveAi(m.id, { ai_summary: result.summary });
  res.json({ ...result, provider: ai.aiInfo().provider });
}));

api.post('/ai/draft', wrap(async (req, res) => {
  requireAi(req);
  const { messageId, instructions, tone } = req.body || {};
  let messages = [];
  if (messageId) {
    const m = store.getMessage(req.mbx, messageId);
    if (!m) throw httpError(404, 'Message not found.');
    messages = store.getThread(req.mbx, m.thread_id);
  }
  res.json(await ai.draft({ messages, instructions, tone, user: req.user }));
}));

api.post('/ai/rewrite', wrap(async (req, res) => {
  requireAi(req);
  res.json({ text: await ai.rewrite({ text: req.body?.text || '', style: req.body?.style }) });
}));

api.post('/ai/triage', wrap(async (req, res) => {
  requireAi(req);
  const m = store.getMessage(req.mbx, req.body?.messageId);
  if (!m) throw httpError(404, 'Message not found.');
  const t = await ai.triage(m);
  store.saveAi(m.id, { ai_priority: t.priority, ai_category: t.category, ai_needs_reply: !!t.needsReply, is_focused: t.focused !== false });
  res.json(t);
}));

api.use(features);
api.use(calendar);

// ------------------------------------------------------------ organization admin (private tenants)
function orgIdFor(req) {
  // Superadmins may act on any org via ?org=; org admins only on their own
  if (req.user.is_admin && req.query.org) return Number(req.query.org);
  if (req.user.org_kind !== 'private' && !req.user.is_admin) throw httpError(403, 'Not an organization account.');
  return req.user.org_id;
}

api.get('/org', requireOrgAdmin, (req, res) => {
  const id = orgIdFor(req);
  res.json({ org: db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) });
});

api.get('/org/users', requireOrgAdmin, (req, res) => {
  res.json({ users: db.prepare('SELECT id, email, name, role, is_disabled, created_at FROM users WHERE org_id = ? ORDER BY email').all(orgIdFor(req)) });
});

api.post('/org/users', requireOrgAdmin, wrap(async (req, res) => {
  const { username, domain, name, password, role } = req.body || {};
  const user = createUser({ username, domain, name, password, role, orgId: orgIdFor(req) });
  res.status(201).json({ user });
}));

api.patch('/org/users/:id', requireOrgAdmin, wrap(async (req, res) => {
  const orgId = orgIdFor(req);
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(Number(req.params.id), orgId);
  if (!u) throw httpError(404, 'User not found.');
  const b = req.body || {};
  if (typeof b.is_disabled === 'boolean') {
    if (u.id === req.user.id) throw httpError(400, 'You cannot disable your own account.');
    db.prepare('UPDATE users SET is_disabled = ? WHERE id = ?').run(b.is_disabled ? 1 : 0, u.id);
    if (b.is_disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  if (b.role === 'user' || b.role === 'org_admin') db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
  if (b.password) {
    const err = validatePassword(b.password);
    if (err) throw httpError(400, err);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  res.json({ user: getUser(u.id) });
}));

api.get('/org/domains', requireOrgAdmin, (req, res) => {
  const domains = db.prepare('SELECT id, name, verified, verify_token, created_at FROM domains WHERE org_id = ?').all(orgIdFor(req));
  res.json({ domains: domains.map(dnsInstructions) });
});

api.post('/org/domains', requireOrgAdmin, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().toLowerCase();
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw httpError(400, 'Enter a valid domain such as example.com.');
  if (db.prepare('SELECT 1 FROM domains WHERE name = ?').get(name)) throw httpError(409, 'That domain is already registered.');
  const token = `arzio-verify=${crypto.randomBytes(12).toString('hex')}`;
  const r = db.prepare('INSERT INTO domains (org_id, name, verify_token) VALUES (?, ?, ?)').run(orgIdFor(req), name, token);
  res.status(201).json({ domain: dnsInstructions(db.prepare('SELECT * FROM domains WHERE id = ?').get(r.lastInsertRowid)) });
}));

api.post('/org/domains/:id/verify', requireOrgAdmin, wrap(async (req, res) => {
  const d = db.prepare('SELECT * FROM domains WHERE id = ? AND org_id = ?').get(Number(req.params.id), orgIdFor(req));
  if (!d) throw httpError(404, 'Domain not found.');
  let records = [];
  try { records = (await dns.resolveTxt(d.name)).map((r) => r.join('')); } catch { /* no records */ }
  if (!records.includes(d.verify_token) && !(req.user.is_admin && req.body?.force)) {
    throw httpError(400, `TXT record not found yet. Add TXT "${d.verify_token}" on ${d.name}; DNS changes can take up to an hour.`);
  }
  db.prepare('UPDATE domains SET verified = 1 WHERE id = ?').run(d.id);
  res.json({ domain: dnsInstructions(db.prepare('SELECT * FROM domains WHERE id = ?').get(d.id)) });
}));

function dnsInstructions(d) {
  return {
    ...d,
    verified: !!d.verified,
    dns: [
      { type: 'TXT', host: d.name, value: d.verify_token, purpose: 'Proves you own the domain' },
      { type: 'MX', host: d.name, value: `10 mx.${config.primaryDomain}`, purpose: 'Delivers incoming mail to Arzio' },
      { type: 'TXT', host: d.name, value: 'v=spf1 include:<your SES/Postmark SPF include> ~all', purpose: 'Authorizes outbound mail (SPF)' },
      { type: 'TXT', host: `_dmarc.${d.name}`, value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@' + d.name, purpose: 'DMARC policy' },
    ],
  };
}

// ------------------------------------------------------------ service admin (superadmin)
api.get('/admin/orgs', requireAdmin, (req, res) => {
  res.json({
    orgs: db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS users,
      (SELECT group_concat(name, ', ') FROM domains d WHERE d.org_id = o.id) AS domains FROM organizations o ORDER BY o.id`).all(),
  });
});

// Create a private tenant with its first domain and org admin account
api.post('/admin/orgs', requireAdmin, wrap(async (req, res) => {
  const { name, domain, adminUsername, adminName, adminPassword, maxUsers } = req.body || {};
  const dname = String(domain || '').trim().toLowerCase();
  if (!String(name || '').trim()) throw httpError(400, 'Organization name is required.');
  if (db.prepare('SELECT 1 FROM domains WHERE name = ?').get(dname)) throw httpError(409, 'That domain is already registered.');
  const result = tx(() => {
    const o = db.prepare("INSERT INTO organizations (name, kind, max_users) VALUES (?, 'private', ?)").run(String(name).trim(), Number(maxUsers) || 50);
    const orgId = Number(o.lastInsertRowid);
    db.prepare('INSERT INTO domains (org_id, name, verify_token) VALUES (?, ?, ?)').run(orgId, dname, `arzio-verify=${crypto.randomBytes(12).toString('hex')}`);
    return orgId;
  });
  try {
    const admin = createUser({ username: adminUsername, name: adminName, password: adminPassword, orgId: result, domain: dname, role: 'org_admin', allowUnverified: true });
    res.status(201).json({ orgId: result, admin });
  } catch (e) {
    db.prepare('DELETE FROM organizations WHERE id = ?').run(result);
    throw e;
  }
}));
