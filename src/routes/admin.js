// Phase 4: organization admin for teams and compliance (shared mailboxes,
// groups, mail flow rules and DLP, message trace, retention, litigation hold,
// eDiscovery, audit log, reports) and mail import for every user.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db, tx } from '../db.js';
import { config } from '../config.js';
import { httpError, requireOrgAdmin, createUser } from '../auth.js';
import { listTransportRules, SENSITIVE_TYPES } from '../mail/transport-rules.js';
import { listAudit, audit } from '../audit.js';
import * as store from '../mail/store.js';
import { startImapImport, importFile, listJobs, PRESETS } from '../mail/import.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const admin = express.Router();

function orgIdFor(req) {
  if (req.user.is_admin && req.query.org) return Number(req.query.org);
  if (req.user.org_kind !== 'private' && !req.user.is_admin) throw httpError(403, 'Not an organization account.');
  return req.user.org_id;
}
const PERMS = ['read', 'send_on_behalf', 'send_as', 'full'];

function orgUserByEmail(orgId, email) {
  const u = db.prepare('SELECT id, email, name FROM users WHERE email = ? AND org_id = ?').get(String(email || '').trim().toLowerCase(), orgId);
  if (!u) throw httpError(400, `${email} is not a user in this organization.`);
  return u;
}

// ------------------------------------------------------------ shared mailboxes
admin.get('/org/shared-mailboxes', requireOrgAdmin, (req, res) => {
  const orgId = orgIdFor(req);
  const boxes = db.prepare("SELECT id, email, name, is_disabled, created_at FROM users WHERE org_id = ? AND mailbox_type = 'shared' ORDER BY email").all(orgId);
  for (const b of boxes) {
    b.members = db.prepare('SELECT u.email, u.name, d.permission FROM delegates d JOIN users u ON u.id = d.delegate_id WHERE d.owner_id = ? ORDER BY u.email').all(b.id);
  }
  res.json({ mailboxes: boxes });
});

admin.post('/org/shared-mailboxes', requireOrgAdmin, wrap(async (req, res) => {
  const orgId = orgIdFor(req);
  const b = req.body || {};
  // Shared mailboxes have no password of their own: members open them from their account
  const u = createUser({ username: b.username, domain: b.domain, name: b.name, password: crypto.randomBytes(24).toString('base64url'), orgId });
  db.prepare("UPDATE users SET mailbox_type = 'shared', ai_enabled = 0 WHERE id = ?").run(u.id);
  setMembers(orgId, u.id, b.members || []);
  audit(req.user.id, 'admin.shared_mailbox.create', { mailbox: u.email });
  res.status(201).json({ mailbox: { id: u.id, email: u.email } });
}));

function setMembers(orgId, ownerId, members) {
  const rows = members.map((m) => ({ user: orgUserByEmail(orgId, m.email), permission: PERMS.includes(m.permission) ? m.permission : 'full' }));
  tx(() => {
    db.prepare('DELETE FROM delegates WHERE owner_id = ?').run(ownerId);
    for (const r of rows) db.prepare('INSERT OR REPLACE INTO delegates (owner_id, delegate_id, permission) VALUES (?, ?, ?)').run(ownerId, r.user.id, r.permission);
  });
}

admin.put('/org/shared-mailboxes/:id/members', requireOrgAdmin, wrap(async (req, res) => {
  const orgId = orgIdFor(req);
  const box = db.prepare("SELECT id, email FROM users WHERE id = ? AND org_id = ? AND mailbox_type = 'shared'").get(Number(req.params.id), orgId);
  if (!box) throw httpError(404, 'Shared mailbox not found.');
  setMembers(orgId, box.id, req.body?.members || []);
  audit(req.user.id, 'admin.shared_mailbox.members', { mailbox: box.email, members: (req.body?.members || []).map((m) => m.email) });
  res.json({ ok: true });
}));

// ------------------------------------------------------------ groups (distribution lists)
function groupOut(g) {
  return { ...g, allow_external: !!g.allow_external, members: db.prepare('SELECT u.email, u.name FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.email').all(g.id) };
}
admin.get('/org/groups', requireOrgAdmin, (req, res) => {
  res.json({ groups: db.prepare('SELECT * FROM groups WHERE org_id = ? ORDER BY name').all(orgIdFor(req)).map(groupOut) });
});

function saveGroup(orgId, b, existing) {
  const name = String(b.name ?? existing?.name ?? '').trim().slice(0, 100);
  if (!name) throw httpError(400, 'Give the group a name.');
  const members = (b.members ?? existing?.members?.map((m) => m.email) ?? []).map((e) => orgUserByEmail(orgId, typeof e === 'string' ? e : e.email));
  return tx(() => {
    let id = existing?.id;
    if (!id) {
      const local = String(b.username || '').trim().toLowerCase();
      const domain = String(b.domain || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,64}$/.test(local)) throw httpError(400, 'Choose a group address such as sales.');
      if (!db.prepare('SELECT 1 FROM domains WHERE name = ? AND org_id = ? AND verified = 1').get(domain, orgId)) throw httpError(400, 'Pick a verified domain of this organization.');
      const address = `${local}@${domain}`;
      if (db.prepare('SELECT 1 FROM users WHERE email = ? UNION SELECT 1 FROM aliases WHERE address = ? UNION SELECT 1 FROM groups WHERE address = ?').get(address, address, address)) throw httpError(409, 'That address is taken.');
      id = Number(db.prepare('INSERT INTO groups (org_id, name, address, description, allow_external) VALUES (?, ?, ?, ?, ?)').run(orgId, name, address, String(b.description || ''), b.allow_external ? 1 : 0).lastInsertRowid);
    } else {
      db.prepare('UPDATE groups SET name = ?, description = ?, allow_external = ? WHERE id = ?').run(name, String(b.description ?? existing.description), (b.allow_external ?? existing.allow_external) ? 1 : 0, id);
      db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    }
    for (const m of members) db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, m.id);
    return groupOut(db.prepare('SELECT * FROM groups WHERE id = ?').get(id));
  });
}
admin.post('/org/groups', requireOrgAdmin, wrap(async (req, res) => {
  const g = saveGroup(orgIdFor(req), req.body || {});
  audit(req.user.id, 'admin.group.create', { group: g.address });
  res.status(201).json({ group: g });
}));
admin.put('/org/groups/:id', requireOrgAdmin, wrap(async (req, res) => {
  const orgId = orgIdFor(req);
  const g = db.prepare('SELECT * FROM groups WHERE id = ? AND org_id = ?').get(Number(req.params.id), orgId);
  if (!g) throw httpError(404, 'Group not found.');
  const out = saveGroup(orgId, req.body || {}, groupOut(g));
  audit(req.user.id, 'admin.group.update', { group: g.address });
  res.json({ group: out });
}));
admin.delete('/org/groups/:id', requireOrgAdmin, (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ? AND org_id = ?').get(Number(req.params.id), orgIdFor(req));
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
  audit(req.user.id, 'admin.group.delete', { group: g.address });
  res.json({ ok: true });
});

// ------------------------------------------------------------ mail flow rules and DLP
admin.get('/org/sensitive-types', requireOrgAdmin, (req, res) => {
  res.json({ types: Object.entries(SENSITIVE_TYPES).map(([id, t]) => ({ id, label: t.label })) });
});
admin.get('/org/transport-rules', requireOrgAdmin, (req, res) => res.json({ rules: listTransportRules(orgIdFor(req)) }));

function cleanRule(b) {
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw httpError(400, 'Give the rule a name.');
  if (!['block', 'disclaimer', 'bcc'].includes(b.action)) throw httpError(400, 'Choose what the rule does.');
  const m = b.match || {};
  const match = {
    externalRecipients: !!m.externalRecipients,
    subjectContains: String(m.subjectContains || '').slice(0, 200),
    bodyContains: String(m.bodyContains || '').slice(0, 200),
    recipientDomain: String(m.recipientDomain || '').trim().toLowerCase().slice(0, 200),
    sensitiveInfo: (Array.isArray(m.sensitiveInfo) ? m.sensitiveInfo : []).filter((k) => SENSITIVE_TYPES[k]),
  };
  const value = String(b.value || '').slice(0, 2000);
  if (b.action === 'bcc' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw httpError(400, 'Enter the address that gets a copy.');
  if (b.action === 'disclaimer' && !value.trim()) throw httpError(400, 'Enter the disclaimer text.');
  return { name, match, action: b.action, value, enabled: b.enabled !== false };
}
admin.post('/org/transport-rules', requireOrgAdmin, wrap(async (req, res) => {
  const r = cleanRule(req.body || {});
  const id = db.prepare('INSERT INTO transport_rules (org_id, name, match_json, action, value, enabled) VALUES (?, ?, ?, ?, ?, ?)')
    .run(orgIdFor(req), r.name, JSON.stringify(r.match), r.action, r.value, r.enabled ? 1 : 0).lastInsertRowid;
  audit(req.user.id, 'admin.mailflow.create', { rule: r.name, action: r.action });
  res.status(201).json({ id: Number(id) });
}));
admin.put('/org/transport-rules/:id', requireOrgAdmin, wrap(async (req, res) => {
  const r = cleanRule(req.body || {});
  const out = db.prepare('UPDATE transport_rules SET name = ?, match_json = ?, action = ?, value = ?, enabled = ? WHERE id = ? AND org_id = ?')
    .run(r.name, JSON.stringify(r.match), r.action, r.value, r.enabled ? 1 : 0, Number(req.params.id), orgIdFor(req));
  if (!out.changes) throw httpError(404, 'Rule not found.');
  audit(req.user.id, 'admin.mailflow.update', { rule: r.name });
  res.json({ ok: true });
}));
admin.delete('/org/transport-rules/:id', requireOrgAdmin, (req, res) => {
  db.prepare('DELETE FROM transport_rules WHERE id = ? AND org_id = ?').run(Number(req.params.id), orgIdFor(req));
  audit(req.user.id, 'admin.mailflow.delete', { id: Number(req.params.id) });
  res.json({ ok: true });
});

// ------------------------------------------------------------ message trace
admin.get('/org/message-trace', requireOrgAdmin, (req, res) => {
  const orgId = orgIdFor(req);
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const q = String(req.query.q || '').trim().toLowerCase();
  const since = `-${days} days`;
  const events = db.prepare(`SELECT a.created_at AS time, a.action, a.details_json, u.email AS user_email FROM audit_log a JOIN users u ON u.id = a.user_id
      WHERE a.org_id = ? AND a.action IN ('mail.sent', 'mail.received') AND a.created_at > datetime('now', ?) ORDER BY a.id DESC LIMIT 2000`).all(orgId, since)
    .map((r) => {
      const d = JSON.parse(r.details_json);
      return r.action === 'mail.sent'
        ? { time: r.time, direction: 'Sent', from: d.from || r.user_email, to: (d.to || []).join(', '), subject: d.subject || '', status: d.via === 'smtp' ? 'Accepted (mail app)' : 'Accepted' }
        : { time: r.time, direction: 'Received', from: d.from || '', to: d.to || r.user_email, subject: d.subject || '', status: d.junk ? 'Delivered to Junk' : 'Delivered' };
    });
  const remote = db.prepare(`SELECT q.created_at AS time, q.envelope_from, q.rcpts_json, q.subject, q.status, q.attempts, q.last_error FROM delivery_queue q JOIN users u ON u.id = q.user_id
      WHERE u.org_id = ? AND q.created_at > datetime('now', ?) ORDER BY q.id DESC LIMIT 2000`).all(orgId, since)
    .map((r) => ({ time: r.time, direction: 'Outbound', from: r.envelope_from, to: JSON.parse(r.rcpts_json).join(', '), subject: r.subject,
      status: { sent: 'Delivered to remote server', failed: 'Failed (bounced)', pending: r.attempts ? `Retrying (${r.attempts} attempts)` : 'Queued', sending: 'Sending' }[r.status] || r.status, detail: r.last_error || '' }));
  const all = [...events, ...remote].filter((e) => !q || `${e.from} ${e.to} ${e.subject}`.toLowerCase().includes(q)).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 500);
  res.json({ trace: all });
});

// ------------------------------------------------------------ compliance: retention, litigation hold, eDiscovery
admin.get('/org/compliance', requireOrgAdmin, (req, res) => {
  const o = db.prepare('SELECT retention_days, litigation_hold FROM organizations WHERE id = ?').get(orgIdFor(req));
  res.json({ retention_days: o.retention_days || 0, litigation_hold: !!o.litigation_hold });
});
admin.patch('/org/compliance', requireOrgAdmin, (req, res) => {
  const orgId = orgIdFor(req);
  const b = req.body || {};
  if ('retention_days' in b) {
    const n = Number(b.retention_days);
    if (!Number.isInteger(n) || n < 0 || (n > 0 && n < 30)) return res.status(400).json({ error: 'Retention must be off (0) or at least 30 days.' });
    db.prepare('UPDATE organizations SET retention_days = ? WHERE id = ?').run(n, orgId);
  }
  if ('litigation_hold' in b) db.prepare('UPDATE organizations SET litigation_hold = ? WHERE id = ?').run(b.litigation_hold ? 1 : 0, orgId);
  audit(req.user.id, 'admin.compliance.update', b);
  const o = db.prepare('SELECT retention_days, litigation_hold FROM organizations WHERE id = ?').get(orgId);
  res.json({ retention_days: o.retention_days || 0, litigation_hold: !!o.litigation_hold });
});

function discover(orgId, { q, from, to, mailbox }) {
  const where = ['u.org_id = ?'];
  const args = [orgId];
  let src = 'messages m JOIN users u ON u.id = m.user_id';
  if (q) {
    src += ' JOIN messages_fts f ON f.rowid = m.id';
    where.push('messages_fts MATCH ?');
    args.push(String(q).match(/[\p{L}\p{N}@._-]+/gu)?.map((t) => `"${t}"`).join(' ') || '""');
  }
  if (from) { where.push('m.date >= ?'); args.push(new Date(from).toISOString()); }
  if (to) { where.push('m.date <= ?'); args.push(new Date(to).toISOString()); }
  if (mailbox) { where.push('u.email = ?'); args.push(String(mailbox).toLowerCase()); }
  return db.prepare(`SELECT m.id, m.user_id, u.email AS mailbox, m.from_addr, m.subject, m.date, m.raw_path, m.folder_id,
      (SELECT role FROM folders WHERE id = m.folder_id) AS folder_role FROM ${src} WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT 5000`).all(...args);
}
admin.post('/org/ediscovery/search', requireOrgAdmin, wrap(async (req, res) => {
  const hits = discover(orgIdFor(req), req.body || {});
  audit(req.user.id, 'admin.ediscovery.search', { ...req.body, hits: hits.length });
  res.json({ count: hits.length, results: hits.slice(0, 200).map((h) => ({ id: h.id, mailbox: h.mailbox, from: h.from_addr, subject: h.subject, date: h.date, held: h.folder_role === 'recoverable', deleted: h.folder_role === 'trash' })) });
}));
// Export every match as one .mbox file
admin.post('/org/ediscovery/export', requireOrgAdmin, wrap(async (req, res) => {
  const hits = discover(orgIdFor(req), req.body || {});
  audit(req.user.id, 'admin.ediscovery.export', { ...req.body, hits: hits.length });
  res.setHeader('Content-Type', 'application/mbox');
  res.setHeader('Content-Disposition', `attachment; filename="ediscovery-${new Date().toISOString().slice(0, 10)}.mbox"`);
  for (const h of hits) {
    let raw;
    if (h.raw_path && fs.existsSync(h.raw_path)) raw = fs.readFileSync(h.raw_path, 'latin1');
    else {
      const m = store.getMessage(h.user_id, h.id);
      raw = `From: ${m.from_addr}\r\nTo: ${m.to.map((p) => p.address).join(', ')}\r\nSubject: ${m.subject}\r\nDate: ${new Date(m.date).toUTCString()}\r\n\r\n${m.text_body}`;
    }
    res.write(Buffer.from(`From ${h.from_addr || 'unknown'} ${new Date(h.date).toUTCString()}\nX-Arzio-Mailbox: ${h.mailbox}\n${raw.replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1')}\n\n`, 'latin1'));
  }
  res.end();
}));

// ------------------------------------------------------------ audit log and reports
admin.get('/org/audit', requireOrgAdmin, (req, res) => {
  const orgId = orgIdFor(req);
  let userId;
  if (req.query.user) userId = orgUserByEmail(orgId, req.query.user).id;
  res.json({ entries: listAudit({ orgId, userId, action: req.query.action ? String(req.query.action) : undefined, before: req.query.before, limit: 200 }) });
});

admin.get('/org/reports', requireOrgAdmin, (req, res) => {
  const orgId = orgIdFor(req);
  const count = (action) => db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ? AND action = ? AND created_at > datetime('now', '-7 days')").get(orgId, action).n;
  const users = db.prepare(`SELECT u.email, u.name, u.mailbox_type, u.is_disabled, u.totp_enabled,
      (SELECT COALESCE(SUM(size), 0) FROM messages m WHERE m.user_id = u.id) AS bytes,
      (SELECT MAX(created_at) FROM audit_log a WHERE a.user_id = u.id) AS last_activity
      FROM users u WHERE u.org_id = ? ORDER BY bytes DESC`).all(orgId);
  res.json({
    sent7d: count('mail.sent'), received7d: count('mail.received'), junk7d: db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ? AND action = 'mail.received' AND details_json LIKE '%\"junk\":true%' AND created_at > datetime('now', '-7 days')").get(orgId).n,
    failed7d: db.prepare("SELECT COUNT(*) AS n FROM delivery_queue q JOIN users u ON u.id = q.user_id WHERE u.org_id = ? AND q.status = 'failed' AND q.created_at > datetime('now', '-7 days')").get(orgId).n,
    mfaUsers: users.filter((u) => u.totp_enabled && u.mailbox_type !== 'shared').length,
    quotaBytes: config.quotas.mailboxBytes,
    users: users.map((u) => ({ ...u, is_disabled: !!u.is_disabled, totp_enabled: !!u.totp_enabled })),
  });
});

// ------------------------------------------------------------ mail import (every user)
admin.get('/me/import', (req, res) => res.json({ jobs: listJobs(req.user.id), presets: PRESETS }));
admin.post('/me/import/imap', wrap(async (req, res) => {
  if (req.tokenScopes) throw httpError(403, 'API tokens cannot start imports.');
  const b = req.body || {};
  const preset = PRESETS[b.provider] || {};
  const id = await startImapImport(req.user, { host: b.host || preset.host, port: b.port || preset.port || 993, secure: b.secure ?? preset.secure ?? true, username: b.username, password: b.password });
  res.status(202).json({ jobId: id });
}));
admin.post('/me/import/file', wrap(async (req, res) => {
  const b = req.body || {};
  const content = Buffer.from(String(b.contentBase64 || ''), 'base64');
  if (!content.length) throw httpError(400, 'Choose an .eml or .mbox file.');
  res.json(await importFile(req.user, { filename: String(b.filename || ''), content, folderId: b.folderId }));
}));
