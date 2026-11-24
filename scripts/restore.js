#!/usr/bin/env node
// Restore an Arzio Mail backup made by scripts/backup.js.
//
//   node scripts/restore.js /backups/arzio-backup-20261124-020000.tar.gz [--force]
//
// Stop the server first. Restores into ARZIO_DATA_DIR (default ./data). The
// folder must be empty unless you pass --force, in which case the current
// contents are moved aside to <data>.before-restore-<time> first.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
const dataDir = path.resolve(process.env.ARZIO_DATA_DIR || './data');
if (!file || !fs.existsSync(file)) { console.error('Usage: node scripts/restore.js <backup.tar.gz> [--force]'); process.exit(1); }

if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) {
  if (!force) { console.error(`${dataDir} is not empty. Stop the server and pass --force to move it aside.`); process.exit(1); }
  const aside = `${dataDir}.before-restore-${Date.now()}`;
  fs.renameSync(dataDir, aside);
  console.log(`Moved current data to ${aside}`);
}
fs.mkdirSync(dataDir, { recursive: true });
const r = spawnSync('tar', ['-xzf', path.resolve(file), '-C', dataDir, '-o'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('tar failed'); process.exit(1); }
const pgDump = path.join(dataDir, 'snapshot.pgdump');
if (fs.existsSync(pgDump)) {
  const url = process.env.ARZIO_DB_URL || process.env.DATABASE_URL;
  if (!/^postgres(ql)?:/i.test(url || '')) { console.error('This backup is from PostgreSQL. Set ARZIO_DB_URL to the (empty) database to restore into.'); process.exit(1); }
  const r2 = spawnSync(process.env.PG_RESTORE || 'pg_restore', ['--no-owner', ...(force ? ['--clean', '--if-exists'] : []), '--dbname', url], { stdio: [fs.openSync(pgDump, 'r'), 'inherit', 'inherit'] });
  fs.rmSync(pgDump);
  if (r2.status !== 0) { console.error('pg_restore reported errors (see above).'); process.exit(1); }
  console.log(`Restored the PostgreSQL database and mail files into ${dataDir}. Start the server.`);
  process.exit(0);
}
const snap = path.join(dataDir, 'snapshot.db');
if (fs.existsSync(snap)) fs.renameSync(snap, path.join(dataDir, 'arzio.db'));
const db = new DatabaseSync(path.join(dataDir, 'arzio.db'), { readOnly: true });
const ok = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
const n = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
db.close();
if (ok !== 'ok') { console.error('Restored database failed its integrity check.'); process.exit(1); }
console.log(`Restored ${n} messages into ${dataDir}. Start the server.`);
