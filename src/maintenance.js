// Hourly housekeeping: empty old Deleted Items, apply organization retention
// policies (skipped under litigation hold), clear expired sessions and old queue rows.
import { db, isJobLeader } from './db.js';
import { runBillingMaintenance } from './billing.js';
import { purgeMessage } from './mail/store.js';

function purge(rows) {
  for (const m of rows) purgeMessage(m.id);
  return rows.length;
}

export function runMaintenance() {
  let purged = 0;
  // Deleted Items older than each user's setting (not for orgs on litigation hold)
  purged += purge(db.prepare(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id JOIN users u ON u.id = m.user_id
    JOIN organizations o ON o.id = u.org_id
    WHERE f.role = 'trash' AND u.trash_days > 0 AND o.litigation_hold = 0
      AND m.created_at < datetime('now', '-' || u.trash_days || ' days') LIMIT 5000`).all());
  // Organization retention policy: delete mail older than N days
  purged += purge(db.prepare(`SELECT m.id FROM messages m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = u.org_id
    WHERE o.retention_days > 0 AND o.litigation_hold = 0 AND m.date < datetime('now', '-' || o.retention_days || ' days') LIMIT 5000`).all());
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  db.prepare("DELETE FROM delivery_queue WHERE status IN ('sent', 'failed') AND created_at < datetime('now', '-30 days')").run();
  db.prepare("DELETE FROM outbox WHERE status IN ('sent', 'cancelled', 'failed') AND created_at < datetime('now', '-30 days')").run();
  runBillingMaintenance();
  return { purged };
}

export function startMaintenance() {
  const t = setInterval(() => { try { if (isJobLeader()) runMaintenance(); } catch (e) { console.error('[maintenance]', e); } }, 3600e3);
  t.unref();
  return t;
}
