// Organization mail flow rules applied to outgoing mail (like Exchange transport rules):
// block messages that match, or append a disclaimer.
import { db } from '../db.js';

export function listTransportRules(orgId) {
  return db.prepare('SELECT * FROM transport_rules WHERE org_id = ? ORDER BY id').all(orgId)
    .map((r) => ({ id: r.id, name: r.name, match: JSON.parse(r.match_json), action: r.action, value: r.value, enabled: !!r.enabled }));
}

// Data loss prevention: sensitive information types (like Purview DLP)
function luhn(num) {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
export const SENSITIVE_TYPES = {
  credit_card: { label: 'Credit card numbers', test: (t) => (t.match(/\b(?:\d[ -]?){13,19}\b/g) || []).some((x) => { const n = x.replace(/\D/g, ''); return n.length >= 13 && n.length <= 19 && luhn(n); }) },
  aadhaar: { label: 'Aadhaar numbers (India)', test: (t) => /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/.test(t) },
  pan: { label: 'PAN card numbers (India)', test: (t) => /\b[A-Z]{5}\d{4}[A-Z]\b/.test(t) },
  iban: { label: 'IBAN bank account numbers', test: (t) => /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/.test(t) },
  us_ssn: { label: 'US Social Security numbers', test: (t) => /\b\d{3}-\d{2}-\d{4}\b/.test(t) },
};

/**
 * Apply the organization's rules to an outgoing message.
 * Returns { text, block?, bcc: [addresses], matched: [rule names] }.
 */
export function applyTransportRules(user, { to, subject, text }) {
  const result = { text: String(text || ''), bcc: [], matched: [] };
  if (!user.org_id) return result;
  const orgDomains = db.prepare('SELECT name FROM domains WHERE org_id = ?').all(user.org_id).map((d) => d.name);
  const external = to.some((p) => !orgDomains.includes(String(p.address).split('@')[1]));
  for (const r of listTransportRules(user.org_id)) {
    if (!r.enabled) continue;
    const m = r.match || {};
    const body = result.text;
    if (m.externalRecipients && !external) continue;
    if (m.subjectContains && !String(subject || '').toLowerCase().includes(m.subjectContains.toLowerCase())) continue;
    if (m.bodyContains && !body.toLowerCase().includes(m.bodyContains.toLowerCase())) continue;
    if (m.recipientDomain && !to.some((p) => String(p.address).toLowerCase().endsWith(`@${m.recipientDomain.toLowerCase()}`))) continue;
    if (Array.isArray(m.sensitiveInfo) && m.sensitiveInfo.length) {
      const hay = `${subject || ''}\n${body}`;
      if (!m.sensitiveInfo.some((k) => SENSITIVE_TYPES[k]?.test(hay))) continue;
    }
    result.matched.push(r.name);
    if (r.action === 'block') return { ...result, block: r.value || `Blocked by your organization's policy: ${r.name}` };
    if (r.action === 'disclaimer' && r.value && !body.includes(r.value)) result.text = `${body}\n\n${r.value}`;
    if (r.action === 'bcc' && r.value) result.bcc.push(r.value.toLowerCase());
  }
  return result;
}
