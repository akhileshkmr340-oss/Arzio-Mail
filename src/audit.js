// Audit log for security and compliance (who did what, when).
import { db } from './db.js';

export function audit(userId, action, details = {}) {
  try {
    const u = userId ? db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId) : null;
    db.prepare('INSERT INTO audit_log (user_id, org_id, action, details_json) VALUES (?, ?, ?, ?)')
      .run(userId || null, u?.org_id || null, action, JSON.stringify(details).slice(0, 4000));
  } catch (e) {
    console.warn('[audit]', e.message);
  }
}

export function listAudit({ orgId, userId, action, limit = 200, before }) {
  const where = [];
  const args = [];
  if (orgId) { where.push('a.org_id = ?'); args.push(orgId); }
  if (userId) { where.push('a.user_id = ?'); args.push(userId); }
  if (action) { where.push('a.action LIKE ?'); args.push(`${action}%`); }
  if (before) { where.push('a.id < ?'); args.push(Number(before)); }
  return db.prepare(`SELECT a.id, a.action, a.details_json, a.created_at, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 200, 1000))
    .map((r) => ({ ...r, details: JSON.parse(r.details_json), details_json: undefined }));
}
