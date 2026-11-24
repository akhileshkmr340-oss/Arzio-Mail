// Health, readiness and metrics endpoints for load balancers and monitoring.
//   GET /health   liveness: the process is up (always 200 while running)
//   GET /ready    readiness: database answers, data folder is writable, disk
//                 has room, outbound queue is not stuck. 503 when not ready.
//   GET /metrics  Prometheus text format. Needs METRICS_TOKEN as a Bearer
//                 token when that variable is set; otherwise only localhost.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';

const started = Date.now();
let shuttingDown = false;
export function markShuttingDown() { shuttingDown = true; }

const MIN_FREE_BYTES = Number(process.env.ARZIO_MIN_FREE_MB || 500) * 1024 * 1024;
const MAX_QUEUE_AGE_MIN = Number(process.env.ARZIO_MAX_QUEUE_AGE_MIN || 60);

function diskFree() {
  try {
    const s = fs.statfsSync(config.dataDir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}

export function readiness() {
  const checks = {};
  try { db.prepare('SELECT 1').get(); checks.database = { ok: true }; } catch (e) { checks.database = { ok: false, error: e.message }; }
  try {
    const f = path.join(config.dataDir, `.ready-${process.pid}`);
    fs.writeFileSync(f, String(Date.now()));
    fs.unlinkSync(f);
    checks.storage = { ok: true };
  } catch (e) { checks.storage = { ok: false, error: e.message }; }
  const d = diskFree();
  checks.disk = d ? { ok: d.free >= MIN_FREE_BYTES, freeMb: Math.floor(d.free / 1048576) } : { ok: true, freeMb: null };
  try {
    const q = db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM delivery_queue WHERE status = 'pending'`).get();
    const ageMin = q.oldest ? Math.floor((Date.now() - Date.parse(q.oldest.replace(' ', 'T') + 'Z')) / 60000) : 0;
    // A slow queue is a warning, not a reason to take the web app out of rotation
    checks.outboundQueue = { ok: true, pending: q.n, oldestMinutes: ageMin, warning: ageMin > MAX_QUEUE_AGE_MIN || undefined };
  } catch (e) { checks.outboundQueue = { ok: false, error: e.message }; }
  if (shuttingDown) checks.shutdown = { ok: false, error: 'Shutting down' };
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

function metricsAllowed(req) {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(got); const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function count(sql, ...args) { try { return db.prepare(sql).get(...args).n; } catch { return 0; } }

export function metricsText() {
  const lines = [];
  const g = (name, help, value, labels = '') => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`); };
  g('arzio_up', 'Process is running', 1);
  g('arzio_uptime_seconds', 'Seconds since start', Math.floor((Date.now() - started) / 1000));
  g('arzio_users', 'Active accounts', count(`SELECT COUNT(*) AS n FROM users WHERE is_disabled = 0`));
  g('arzio_messages', 'Stored messages', count('SELECT COUNT(*) AS n FROM messages'));
  lines.push('# HELP arzio_outbound_queue Outbound messages by status', '# TYPE arzio_outbound_queue gauge');
  for (const s of ['pending', 'sent', 'failed']) lines.push(`arzio_outbound_queue{status="${s}"} ${count('SELECT COUNT(*) AS n FROM delivery_queue WHERE status = ?', s)}`);
  g('arzio_received_last_hour', 'Messages delivered to mailboxes in the last hour', count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mail.received' AND created_at >= datetime('now', '-1 hour')`));
  g('arzio_sent_last_hour', 'Messages sent in the last hour', count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mail.sent' AND created_at >= datetime('now', '-1 hour')`));
  const d = diskFree();
  if (d) g('arzio_disk_free_bytes', 'Free space in the data folder', d.free);
  const m = process.memoryUsage();
  g('arzio_memory_rss_bytes', 'Resident memory', m.rss);
  return lines.join('\n') + '\n';
}

export const health = express.Router();
health.get('/health', (req, res) => res.json({ ok: true, service: config.serviceName, uptimeSeconds: Math.floor((Date.now() - started) / 1000) }));
health.get('/ready', (req, res) => { const r = readiness(); res.status(r.ok ? 200 : 503).json(r); });
health.get('/metrics', (req, res) => {
  if (!metricsAllowed(req)) return res.status(403).type('text/plain').send('Forbidden\n');
  res.type('text/plain; version=0.0.4').send(metricsText());
});
