// Phase 2+ user features: preferences, two-step verification, rules, templates,
// contacts, sender lists, sweep, scheduled/undo send, aliases, delegation, AI coaching and Q&A.
import express from 'express';
import { useAi } from '../billing.js';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { db } from '../db.js';
import { getUser, verifyPassword, httpError } from '../auth.js';
import { generateSecret, verifyTotp, otpauthUri } from '../mfa.js';
import * as store from '../mail/store.js';
import { validateRule, listRules, applyRules, suggestContacts, setSenderList } from '../mail/features.js';
import { cancelQueued, listScheduled, sendIdentities } from '../mail/delivery.js';
import * as connected from '../mail/connected.js';
import * as ai from '../ai/index.js';
import { audit } from '../audit.js';

export const features = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const intOr = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);

// ------------------------------------------------------------ preferences
features.patch('/me/preferences', wrap(async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const args = [];
  const set = (col, v) => { sets.push(`${col} = ?`); args.push(v); };
  if ('ooo_enabled' in b) set('ooo_enabled', b.ooo_enabled ? 1 : 0);
  if ('ooo_subject' in b) set('ooo_subject', String(b.ooo_subject || '').slice(0, 200));
  if ('ooo_message' in b) set('ooo_message', String(b.ooo_message || '').slice(0, 5000));
  if ('ooo_start' in b) set('ooo_start', b.ooo_start ? new Date(b.ooo_start).toISOString() : null);
  if ('ooo_end' in b) set('ooo_end', b.ooo_end ? new Date(b.ooo_end).toISOString() : null);
  if ('undo_send_seconds' in b) set('undo_send_seconds', Math.min(Math.max(intOr(b.undo_send_seconds, 10), 0), 30));
  if ('focused_inbox' in b) set('focused_inbox', b.focused_inbox ? 1 : 0);
  if ('trash_days' in b) set('trash_days', Math.min(Math.max(intOr(b.trash_days, 30), 0), 3650));
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, req.user.id);
  res.json({ user: getUser(req.user.id) });
}));

// ------------------------------------------------------------ two-step verification (TOTP)
features.post('/me/mfa/setup', wrap(async (req, res) => {
  const secret = generateSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, req.user.id);
  const uri = otpauthUri(secret, req.user.email, config.serviceName);
  res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 200 }) });
}));

features.post('/me/mfa/enable', wrap(async (req, res) => {
  const u = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
  if (!u.totp_secret) throw httpError(400, 'Start setup first.');
  if (!verifyTotp(u.totp_secret, req.body?.code)) throw httpError(400, 'That code is not valid. Check the time on your phone and try the latest code.');
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user.id);
  audit(req.user.id, 'security.mfa_enabled');
  res.json({ user: getUser(req.user.id) });
}));

features.post('/me/mfa/disable', wrap(async (req, res) => {
  const u = db.prepare('SELECT password_hash, totp_secret FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body?.password || ''), u.password_hash)) throw httpError(400, 'Password is wrong.');
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.user.id);
  audit(req.user.id, 'security.mfa_disabled');
  res.json({ user: getUser(req.user.id) });
}));

// ------------------------------------------------------------ rules
features.get('/rules', (req, res) => res.json({ rules: listRules(req.mbx) }));
features.post('/rules', wrap(async (req, res) => {
  const r = validateRule(req.body);
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM rules WHERE user_id = ?').get(req.mbx).p;
  const ins = db.prepare('INSERT INTO rules (user_id, name, conditions_json, actions_json, enabled, position) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.mbx, r.name, JSON.stringify(r.conditions), JSON.stringify(r.actions), r.enabled ? 1 : 0, pos);
  res.status(201).json({ rule: listRules(req.mbx).find((x) => x.id === Number(ins.lastInsertRowid)) });
}));
features.put('/rules/:id', wrap(async (req, res) => {
  const r = validateRule(req.body);
  const u = db.prepare('UPDATE rules SET name = ?, conditions_json = ?, actions_json = ?, enabled = ? WHERE id = ? AND user_id = ?')
    .run(r.name, JSON.stringify(r.conditions), JSON.stringify(r.actions), r.enabled ? 1 : 0, Number(req.params.id), req.mbx);
  if (!u.changes) throw httpError(404, 'Rule not found.');
  res.json({ rule: listRules(req.mbx).find((x) => x.id === Number(req.params.id)) });
}));
features.delete('/rules/:id', (req, res) => {
  db.prepare('DELETE FROM rules WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.mbx);
  res.json({ ok: true });
});
// Run all rules now on the Inbox (like Outlook's "Run rules now")
features.post('/rules/run', wrap(async (req, res) => {
  const inbox = store.folderByRole(req.mbx, 'inbox');
  const ids = db.prepare('SELECT id FROM messages WHERE user_id = ? AND folder_id = ?').all(req.mbx, inbox.id).map((r) => r.id);
  for (const id of ids) applyRules(req.mbx, id);
  res.json({ processed: ids.length });
}));

// ------------------------------------------------------------ templates
features.get('/templates', (req, res) => res.json({ templates: db.prepare('SELECT * FROM templates WHERE user_id = ? ORDER BY name').all(req.user.id) }));
features.post('/templates', wrap(async (req, res) => {
  const { name, subject = '', body = '' } = req.body || {};
  if (!String(name || '').trim()) throw httpError(400, 'Give the template a name.');
  const r = db.prepare('INSERT INTO templates (user_id, name, subject, body) VALUES (?, ?, ?, ?)').run(req.user.id, String(name).trim().slice(0, 100), String(subject).slice(0, 998), String(body).slice(0, 50000));
  res.status(201).json({ template: db.prepare('SELECT * FROM templates WHERE id = ?').get(r.lastInsertRowid) });
}));
features.delete('/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------ contacts (People)
const CONTACT_FIELDS = ['email', 'name', 'phone', 'company', 'job_title', 'notes'];
function cleanContact(b) {
  const c = {};
  for (const f of CONTACT_FIELDS) c[f] = String(b?.[f] ?? '').trim().slice(0, f === 'notes' ? 5000 : 200);
  c.email = c.email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw httpError(400, 'Enter a valid email address.');
  return c;
}
features.get('/contacts/suggest', (req, res) => res.json({ suggestions: suggestContacts(req.user, req.query.q || '') }));
features.get('/contacts', (req, res) => {
  const like = `%${String(req.query.q || '').toLowerCase()}%`;
  res.json({ contacts: db.prepare(`SELECT * FROM contacts WHERE user_id = ? AND (is_saved = 1 OR ? = '1') AND (lower(email) LIKE ? OR lower(name) LIKE ? OR lower(company) LIKE ?)
    ORDER BY lower(CASE WHEN name = '' THEN email ELSE name END) LIMIT 1000`).all(req.user.id, req.query.all === '1' ? '1' : '0', like, like, like) });
});
features.post('/contacts', wrap(async (req, res) => {
  const c = cleanContact(req.body);
  db.prepare(`INSERT INTO contacts (user_id, email, name, phone, company, job_title, notes, is_saved) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(user_id, email) DO UPDATE SET name = excluded.name, phone = excluded.phone, company = excluded.company, job_title = excluded.job_title, notes = excluded.notes, is_saved = 1`)
    .run(req.user.id, c.email, c.name, c.phone, c.company, c.job_title, c.notes);
  res.status(201).json({ contact: db.prepare('SELECT * FROM contacts WHERE user_id = ? AND email = ?').get(req.user.id, c.email) });
}));
features.put('/contacts/:id', wrap(async (req, res) => {
  const c = cleanContact(req.body);
  const r = db.prepare('UPDATE contacts SET email = ?, name = ?, phone = ?, company = ?, job_title = ?, notes = ?, is_saved = 1 WHERE id = ? AND user_id = ?')
    .run(c.email, c.name, c.phone, c.company, c.job_title, c.notes, Number(req.params.id), req.user.id);
  if (!r.changes) throw httpError(404, 'Contact not found.');
  res.json({ contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(req.params.id)) });
}));
features.delete('/contacts/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});
// Export contacts as vCard
features.get('/contacts.vcf', (req, res) => {
  const rows = db.prepare('SELECT * FROM contacts WHERE user_id = ? AND is_saved = 1').all(req.user.id);
  const esc = (v) => String(v || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.vcf"');
  res.send(rows.map((c) => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.name || c.email)}`, `EMAIL;TYPE=INTERNET:${c.email}`,
    c.phone && `TEL:${esc(c.phone)}`, c.company && `ORG:${esc(c.company)}`, c.job_title && `TITLE:${esc(c.job_title)}`, c.notes && `NOTE:${esc(c.notes)}`, 'END:VCARD'].filter(Boolean).join('\r\n')).join('\r\n') + '\r\n');
});

// ------------------------------------------------------------ safe / blocked senders, junk reporting, sweep
features.get('/senders', (req, res) => res.json({ senders: db.prepare('SELECT * FROM sender_lists WHERE user_id = ? ORDER BY kind, address').all(req.mbx) }));
features.post('/senders', wrap(async (req, res) => { setSenderList(req.mbx, req.body?.address, req.body?.kind === 'safe' ? 'safe' : 'blocked'); res.status(201).json({ ok: true }); }));
features.delete('/senders/:id', (req, res) => { db.prepare('DELETE FROM sender_lists WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.mbx); res.json({ ok: true }); });

features.post('/messages/:id/report', wrap(async (req, res) => {
  const m = store.getMessage(req.mbx, req.params.id);
  if (!m) throw httpError(404, 'Message not found.');
  const junk = req.body?.junk !== false;
  store.updateMessage(req.mbx, m.id, { folder_id: store.folderByRole(req.mbx, junk ? 'junk' : 'inbox').id });
  if (req.body?.remember !== false && m.from_addr) setSenderList(req.mbx, m.from_addr, junk ? 'blocked' : 'safe');
  res.json({ ok: true });
}));

features.post('/messages/sweep', wrap(async (req, res) => {
  const { sender, action = 'delete', folder_id } = req.body || {};
  const addr = String(sender || '').toLowerCase();
  if (!addr) throw httpError(400, 'Choose a sender.');
  const target = action === 'archive' ? store.folderByRole(req.mbx, 'archive') : action === 'move' ? store.folderById(req.mbx, folder_id) : store.folderByRole(req.mbx, 'trash');
  if (!target) throw httpError(400, 'Choose a folder.');
  const inbox = store.folderByRole(req.mbx, 'inbox');
  const r = db.prepare('UPDATE messages SET folder_id = ? WHERE user_id = ? AND from_addr = ? AND folder_id = ?').run(target.id, req.mbx, addr, inbox.id);
  if (req.body?.always) {
    db.prepare('INSERT INTO rules (user_id, name, conditions_json, actions_json, position) VALUES (?, ?, ?, ?, 0)')
      .run(req.mbx, `Sweep: ${addr}`, JSON.stringify([{ field: 'from', op: 'equals', value: addr }]), JSON.stringify([{ type: action === 'delete' ? 'delete' : 'move', value: String(target.id) }]));
  }
  res.json({ moved: r.changes });
}));

// ------------------------------------------------------------ outbox: undo send and scheduled send
features.get('/outbox', (req, res) => res.json({ items: listScheduled(req.user.id) }));
features.post('/outbox/:id/cancel', wrap(async (req, res) => res.json({ draft: cancelQueued(req.user.id, req.params.id) })));

// ------------------------------------------------------------ aliases and identities
features.get('/me/aliases', (req, res) => res.json({ aliases: db.prepare('SELECT id, address FROM aliases WHERE user_id = ?').all(req.user.id) }));
features.post('/me/aliases', wrap(async (req, res) => {
  // Public users may add up to 5 aliases on the public domain; organization aliases are managed by the org admin
  if (req.user.org_kind !== 'public') throw httpError(403, 'Ask your organization admin to add aliases.');
  const n = db.prepare('SELECT COUNT(*) AS n FROM aliases WHERE user_id = ?').get(req.user.id).n;
  if (n >= 5) throw httpError(400, 'You can have up to 5 aliases.');
  const local = String(req.body?.username || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/.test(local)) throw httpError(400, 'Alias must be 3 to 32 letters, numbers, dots, dashes or underscores.');
  const address = `${local}@${config.primaryDomain}`;
  if (db.prepare('SELECT 1 FROM users WHERE email = ? UNION SELECT 1 FROM aliases WHERE address = ? UNION SELECT 1 FROM groups WHERE address = ?').get(address, address, address)) throw httpError(409, 'That address is taken.');
  db.prepare('INSERT INTO aliases (address, user_id) VALUES (?, ?)').run(address, req.user.id);
  res.status(201).json({ address });
}));
features.delete('/me/aliases/:id', (req, res) => {
  if (req.user.org_kind !== 'public') return res.status(403).json({ error: 'Ask your organization admin to remove aliases.' });
  db.prepare('DELETE FROM aliases WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});
features.get('/me/identities', (req, res) => res.json({ identities: sendIdentities(req.user) }));

// ------------------------------------------------------------ connected accounts (mailboxes at other providers)
const noTokens = (req) => { if (req.tokenScopes) throw httpError(403, 'API tokens cannot manage connected accounts.'); };
features.get('/me/connected', (req, res) => res.json({ accounts: connected.listAccounts(req.user.id), providers: connected.PROVIDERS, demo: !!config.demo }));
features.post('/me/connected', wrap(async (req, res) => { noTokens(req); res.status(201).json({ account: await connected.addAccount(req.user, req.body || {}) }); }));
features.patch('/me/connected/:id', wrap(async (req, res) => { noTokens(req); res.json({ account: connected.updateAccount(req.user, req.params.id, req.body || {}) }); }));
features.delete('/me/connected/:id', wrap(async (req, res) => { noTokens(req); connected.removeAccount(req.user, req.params.id); res.json({ ok: true }); }));
features.post('/me/connected/:id/sync', wrap(async (req, res) => {
  if (!connected.listAccounts(req.user.id).some((a) => a.id === Number(req.params.id))) throw httpError(404, 'Account not found.');
  res.json(await connected.syncAccount(Number(req.params.id)));
}));

// ------------------------------------------------------------ delegation and shared mailboxes
// Mailboxes I can open (shared mailboxes and people who delegated to me)
features.get('/me/mailboxes', (req, res) => {
  res.json({ mailboxes: db.prepare(`SELECT u.id, u.email, u.name, u.mailbox_type, d.permission FROM delegates d JOIN users u ON u.id = d.owner_id
    WHERE d.delegate_id = ? AND u.is_disabled = 0 ORDER BY u.mailbox_type DESC, u.email`).all(req.user.id) });
});
// People I gave access to my own mailbox
features.get('/me/delegates', (req, res) => {
  res.json({ delegates: db.prepare('SELECT u.id, u.email, u.name, d.permission FROM delegates d JOIN users u ON u.id = d.delegate_id WHERE d.owner_id = ?').all(req.user.id) });
});
const PERMS = ['read', 'send_on_behalf', 'send_as', 'full'];
features.post('/me/delegates', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const permission = PERMS.includes(req.body?.permission) ? req.body.permission : 'full';
  const d = db.prepare("SELECT id, org_id FROM users WHERE email = ? AND mailbox_type = 'user' AND is_disabled = 0").get(email);
  if (!d || d.id === req.user.id) throw httpError(404, 'No Arzio user with that address.');
  if (req.user.org_kind === 'private' && d.org_id !== req.user.org_id) throw httpError(400, 'You can only delegate to people in your organization.');
  db.prepare('INSERT INTO delegates (owner_id, delegate_id, permission) VALUES (?, ?, ?) ON CONFLICT(owner_id, delegate_id) DO UPDATE SET permission = excluded.permission')
    .run(req.user.id, d.id, permission);
  audit(req.user.id, 'mailbox.delegate_added', { delegate: email, permission });
  res.status(201).json({ ok: true });
}));
features.delete('/me/delegates/:id', (req, res) => {
  db.prepare('DELETE FROM delegates WHERE owner_id = ? AND delegate_id = ?').run(req.user.id, Number(req.params.id));
  audit(req.user.id, 'mailbox.delegate_removed', { delegateId: Number(req.params.id) });
  res.json({ ok: true });
});

// ------------------------------------------------------------ AI: coaching and ask your mailbox
features.post('/ai/coach', wrap(async (req, res) => {
  if (!req.user.ai_enabled) throw httpError(403, 'AI features are turned off in your settings.'); useAi(req.user);
  res.json(await ai.coach({ text: req.body?.text || '', recipients: req.body?.recipients }));
}));

features.post('/ai/ask', wrap(async (req, res) => {
  if (!req.user.ai_enabled) throw httpError(403, 'AI features are turned off in your settings.'); useAi(req.user);
  const question = String(req.body?.question || '').trim();
  if (!question) throw httpError(400, 'Ask a question.');
  const sources = store.searchForQuestion(req.mbx, question, 12);
  const r = await ai.ask({ question, sources });
  const byId = new Map(sources.map((m) => [m.id, m]));
  res.json({
    answer: r.answer,
    sources: (r.citedIds || []).map((id) => byId.get(id)).filter(Boolean)
      .map((m) => ({ id: m.id, subject: m.subject, from_name: m.from_name, from_addr: m.from_addr, date: m.date })),
  });
}));
