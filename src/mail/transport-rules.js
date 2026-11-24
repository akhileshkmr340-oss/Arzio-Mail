// Organization mail flow rules applied to outgoing mail (like Exchange transport rules):
// block messages that match, or append a disclaimer.
import { db } from '../db.js';

export function listTransportRules(orgId) {
  return db.prepare('SELECT * FROM transport_rules WHERE org_id = ? ORDER BY id').all(orgId)
    .map((r) => ({ id: r.id, name: r.name, match: JSON.parse(r.match_json), action: r.action, value: r.value, enabled: !!r.enabled }));
}

export function applyTransportRules(user, { to, subject, text }) {
  if (!user.org_id) return { text };
  const orgDomains = db.prepare('SELECT name FROM domains WHERE org_id = ?').all(user.org_id).map((d) => d.name);
  let out = String(text || '');
  for (const r of listTransportRules(user.org_id)) {
    if (!r.enabled) continue;
    const m = r.match || {};
    const external = to.some((p) => !orgDomains.includes(p.address.split('@')[1]));
    if (m.externalRecipients && !external) continue;
    if (m.subjectContains && !String(subject || '').toLowerCase().includes(m.subjectContains.toLowerCase())) continue;
    if (m.bodyContains && !out.toLowerCase().includes(m.bodyContains.toLowerCase())) continue;
    if (r.action === 'block') return { block: r.value || `Blocked by your organization's policy: ${r.name}`, text: out };
    if (r.action === 'disclaimer' && r.value && !out.includes(r.value)) out = `${out}\n\n${r.value}`;
  }
  return { text: out };
}
