// Phase 2 mailbox features: address resolution (aliases), spam filtering,
// inbox rules, automatic replies, contacts and sender lists.
import { authenticate } from 'mailauth';
import { db } from '../db.js';
import { config } from '../config.js';
import { folderByRole, folderById, updateMessage, deleteMessage, getMessage } from './store.js';

// ------------------------------------------------------------ addresses
export function resolveRecipient(address) {
  const a = String(address || '').toLowerCase();
  const direct = db.prepare('SELECT id, email, name, ai_enabled FROM users WHERE email = ? AND is_disabled = 0').get(a);
  if (direct) return direct;
  const alias = db.prepare('SELECT u.id, u.email, u.name, u.ai_enabled FROM aliases al JOIN users u ON u.id = al.user_id WHERE al.address = ? AND u.is_disabled = 0').get(a);
  if (alias) return alias;
  // Plus addressing: alice+news@arzio.com -> alice@arzio.com
  const m = a.match(/^([^+@]+)\+[^@]*@(.+)$/);
  return m ? resolveRecipient(`${m[1]}@${m[2]}`) : null;
}

export function addressesOf(userId) {
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  return [u.email, ...db.prepare('SELECT address FROM aliases WHERE user_id = ?').all(userId).map((r) => r.address)];
}

// ------------------------------------------------------------ sender lists
export function senderListMatch(userId, address) {
  const a = String(address || '').toLowerCase();
  const domain = '@' + a.split('@')[1];
  const row = db.prepare('SELECT kind FROM sender_lists WHERE user_id = ? AND address IN (?, ?) ORDER BY length(address) DESC LIMIT 1').get(userId, a, domain);
  return row?.kind || null;
}

export function setSenderList(userId, address, kind) {
  const a = String(address || '').trim().toLowerCase();
  if (!/^(@[^@\s]+\.[^@\s]+|[^@\s]+@[^@\s]+\.[^@\s]+)$/.test(a)) throw Object.assign(new Error('Enter an address like name@example.com or @example.com.'), { status: 400 });
  db.prepare('INSERT INTO sender_lists (user_id, address, kind) VALUES (?, ?, ?) ON CONFLICT(user_id, address) DO UPDATE SET kind = excluded.kind').run(userId, a, kind);
}

// ------------------------------------------------------------ spam filtering
const SPAMMY = [
  [/\b(viagra|cialis|casino|lottery|jackpot|bitcoin doubler|crypto giveaway)\b/i, 3],
  [/\b(you have won|claim your prize|winner|act now|100% free|risk[- ]free|no credit check)\b/i, 2],
  [/\b(verify your account|account (has been )?suspended|confirm your password|update your payment)\b/i, 2],
  [/\b(wire transfer|western union|inheritance|beneficiary|next of kin)\b/i, 2],
  [/!!!|\$\$\$/, 1],
];

/**
 * Score an inbound message. Higher = more likely spam; >= 5 goes to Junk.
 * Combines SPF/DKIM/DMARC results with simple content checks.
 */
export async function checkInbound(raw, parsed, smtp = {}) {
  let score = 0;
  const reasons = [];
  let auth = null;
  if (smtp.ip) {
    try {
      const r = await authenticate(raw, { ip: smtp.ip, helo: smtp.helo, sender: smtp.mailFrom, mta: `mx.${config.primaryDomain}`, disableBimi: true, disableArc: true });
      auth = {
        spf: r.spf?.status?.result || 'none',
        dkim: (r.dkim?.results || []).map((d) => d.status?.result).find((x) => x === 'pass') || r.dkim?.results?.[0]?.status?.result || 'none',
        dmarc: r.dmarc?.status?.result || 'none',
        dmarcPolicy: r.dmarc?.policy || null,
      };
      if (auth.spf === 'fail') { score += 3; reasons.push('SPF fail'); }
      if (auth.spf === 'softfail') { score += 1; reasons.push('SPF softfail'); }
      if (auth.dmarc === 'fail') {
        score += auth.dmarcPolicy === 'reject' ? 6 : auth.dmarcPolicy === 'quarantine' ? 5 : 2;
        reasons.push(`DMARC fail (${auth.dmarcPolicy || 'none'})`);
      }
      if (auth.dkim === 'pass') score -= 1;
    } catch (e) {
      reasons.push('auth check error');
    }
  }
  const text = `${parsed.subject || ''}\n${(parsed.text || '').slice(0, 20000)}`;
  for (const [re, pts] of SPAMMY) if (re.test(text)) { score += pts; reasons.push(`content: ${re.source.slice(0, 30)}`); }
  if (!parsed.subject) { score += 1; reasons.push('no subject'); }
  if ((parsed.subject || '').length > 10 && parsed.subject === parsed.subject.toUpperCase() && /[A-Z]/.test(parsed.subject)) { score += 1; reasons.push('all-caps subject'); }
  const exec = (parsed.attachments || []).some((a) => /\.(exe|scr|bat|cmd|js|vbs|jar|msi|com|pif)$/i.test(a.filename || ''));
  if (exec) { score += 5; reasons.push('executable attachment'); }
  return { score, reasons, auth };
}

// ------------------------------------------------------------ rules
const FIELDS = ['from', 'to', 'subject', 'body', 'has_attachment'];
const ACTIONS = ['move', 'read', 'flag', 'category', 'delete', 'forward', 'stop'];

export function validateRule(r) {
  const name = String(r?.name || '').trim().slice(0, 100);
  if (!name) throw Object.assign(new Error('Give the rule a name.'), { status: 400 });
  const conditions = (r.conditions || []).filter((c) => FIELDS.includes(c.field)).map((c) => ({ field: c.field, op: c.op === 'equals' ? 'equals' : 'contains', value: String(c.value ?? '').slice(0, 200) }));
  const actions = (r.actions || []).filter((a) => ACTIONS.includes(a.type)).map((a) => ({ type: a.type, value: a.value == null ? null : String(a.value).slice(0, 200) }));
  if (!conditions.length) throw Object.assign(new Error('Add at least one condition.'), { status: 400 });
  if (!actions.length) throw Object.assign(new Error('Add at least one action.'), { status: 400 });
  return { name, conditions, actions, enabled: r.enabled !== false };
}

export function listRules(userId) {
  return db.prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY position, id').all(userId)
    .map((r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, position: r.position, conditions: JSON.parse(r.conditions_json), actions: JSON.parse(r.actions_json) }));
}

function matches(cond, m) {
  if (cond.field === 'has_attachment') return !!m.has_attachments === (cond.value !== 'false');
  const hay = {
    from: `${m.from_name} ${m.from_addr}`,
    to: [...(m.to || []), ...(m.cc || [])].map((p) => `${p.name} ${p.address}`).join(' '),
    subject: m.subject,
    body: m.text_body,
  }[cond.field] || '';
  const v = cond.value.toLowerCase();
  return cond.op === 'equals' ? hay.trim().toLowerCase() === v || (cond.field === 'from' && m.from_addr === v) : hay.toLowerCase().includes(v);
}

/** Apply the user's rules to a newly delivered message. Returns forward targets. */
export function applyRules(userId, messageId) {
  const m = getMessage(userId, messageId);
  const forwards = [];
  for (const rule of listRules(userId)) {
    if (!rule.enabled || !rule.conditions.every((c) => matches(c, m))) continue;
    let stop = false;
    for (const a of rule.actions) {
      if (a.type === 'move' && folderById(userId, a.value)) updateMessage(userId, messageId, { folder_id: Number(a.value) });
      if (a.type === 'read') updateMessage(userId, messageId, { is_read: true });
      if (a.type === 'flag') updateMessage(userId, messageId, { is_flagged: true });
      if (a.type === 'category' && a.value) {
        const cur = getMessage(userId, messageId).categories;
        if (!cur.includes(a.value)) updateMessage(userId, messageId, { categories: [...cur, a.value] });
      }
      if (a.type === 'delete') deleteMessage(userId, messageId);
      if (a.type === 'forward' && a.value) forwards.push(a.value);
      if (a.type === 'stop') stop = true;
    }
    if (stop) break;
  }
  return forwards;
}

// ------------------------------------------------------------ automatic replies
export function shouldAutoReply(user, parsed, fromAddr) {
  if (!user.ooo_enabled || !fromAddr) return false;
  const now = new Date().toISOString();
  if (user.ooo_start && now < user.ooo_start) return false;
  if (user.ooo_end && now > user.ooo_end) return false;
  const h = parsed.headers;
  const precedence = String(h?.get('precedence') || '').toLowerCase();
  if (['bulk', 'list', 'junk'].includes(precedence)) return false;
  if (h?.get('list-id') || h?.get('list-unsubscribe')) return false;
  const autoSub = String(h?.get('auto-submitted') || 'no').toLowerCase();
  if (autoSub !== 'no') return false;
  if (/^(mailer-daemon|postmaster|no-?reply|bounce)/i.test(fromAddr)) return false;
  if (addressesOf(user.id).includes(fromAddr)) return false;
  // Once per sender every 4 days
  const last = db.prepare('SELECT sent_at FROM auto_reply_log WHERE user_id = ? AND sender = ?').get(user.id, fromAddr);
  if (last && Date.now() - new Date(last.sent_at + 'Z').getTime() < 4 * 86400e3) return false;
  db.prepare("INSERT INTO auto_reply_log (user_id, sender, sent_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_id, sender) DO UPDATE SET sent_at = excluded.sent_at").run(user.id, fromAddr);
  return true;
}

// ------------------------------------------------------------ contacts
export function recordContacts(userId, people) {
  const up = db.prepare(`INSERT INTO contacts (user_id, email, name, use_count, last_used) VALUES (?, ?, ?, 1, datetime('now'))
    ON CONFLICT(user_id, email) DO UPDATE SET use_count = use_count + 1, last_used = excluded.last_used,
      name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END`);
  for (const p of people) if (p.address) up.run(userId, p.address.toLowerCase(), p.name || '');
}

/** Autocomplete: the user's contacts plus colleagues in the same private organization (directory). */
export function suggestContacts(user, q, limit = 8) {
  const like = `%${String(q || '').toLowerCase().replace(/[%_]/g, '')}%`;
  const own = db.prepare(`SELECT email, name, 'contact' AS source FROM contacts WHERE user_id = ? AND (lower(email) LIKE ? OR lower(name) LIKE ?)
    ORDER BY is_saved DESC, use_count DESC, last_used DESC LIMIT ?`).all(user.id, like, like, limit);
  let dir = [];
  if (user.org_kind === 'private') {
    dir = db.prepare(`SELECT email, name, 'directory' AS source FROM users WHERE org_id = ? AND id != ? AND is_disabled = 0 AND (lower(email) LIKE ? OR lower(name) LIKE ?) LIMIT ?`)
      .all(user.org_id, user.id, like, like, limit);
    dir.push(...db.prepare(`SELECT g.address AS email, g.name, 'group' AS source FROM groups g WHERE g.org_id = ? AND (lower(g.address) LIKE ? OR lower(g.name) LIKE ?) LIMIT ?`)
      .all(user.org_id, like, like, limit));
  }
  const seen = new Set();
  return [...own, ...dir].filter((c) => !seen.has(c.email) && seen.add(c.email)).slice(0, limit);
}

export { folderByRole };
