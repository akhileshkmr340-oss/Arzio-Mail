#!/usr/bin/env node
// Back up an Arzio Mail data folder while the server is running.
//
//   node scripts/backup.js [--out /backups] [--keep 14]
//
// Makes one file, arzio-backup-YYYYMMDD-HHMMSS.tar.gz, holding:
//   snapshot.db   (or snapshot.pgdump with PostgreSQL, made by pg_dump)
//                 a consistent copy of the database (SQLite VACUUM INTO,
//                 safe while the server is writing); restore renames it
//   attachments/  attachment files
//   raw/          original messages (.eml)
// Then keeps only the newest --keep backups in the output folder.
// Restore: see scripts/restore.js and docs/OPERATIONS.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const dataDir = path.resolve(process.env.ARZIO_DATA_DIR || './data');
const outDir = path.resolve(opt('out', process.env.ARZIO_BACKUP_DIR || path.join(dataDir, '..', 'backups')));
const keep = Math.max(1, Number(opt('keep', process.env.ARZIO_BACKUP_KEEP || 14)));

const dbFile = path.join(dataDir, 'arzio.db');
const pgUrl = /^postgres(ql)?:/i.test(process.env.ARZIO_DB_URL || process.env.DATABASE_URL || '') ? (process.env.ARZIO_DB_URL || process.env.DATABASE_URL) : null;
if (!pgUrl && !fs.existsSync(dbFile)) { console.error(`No database at ${dbFile}. Set ARZIO_DATA_DIR.`); process.exit(1); }
if (outDir === dataDir || outDir.startsWith(dataDir + path.sep)) { console.error('Put backups outside the data folder.'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

function rotate() {
  const old = fs.readdirSync(outDir).filter((f) => /^arzio-backup-\d{8}-\d{6}\.tar\.gz$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) { fs.unlinkSync(path.join(outDir, f)); console.log(`Removed old backup ${f}`); }
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
// The snapshot sits in the data folder for a moment so one plain `tar -C`
// call (GNU or BusyBox) can pack it with the mail files.
const copy = path.join(dataDir, pgUrl ? 'snapshot.pgdump' : 'snapshot.db');
try {
  fs.rmSync(copy, { force: true });
  if (pgUrl) {
    // PostgreSQL: pg_dump takes a consistent snapshot while the server runs
    const schema = process.env.ARZIO_DB_SCHEMA;
    const out = fs.openSync(copy, 'w');
    const d = spawnSync(process.env.PG_DUMP || 'pg_dump', ['--format=custom', '--no-owner', ...(schema ? ['--schema', schema] : []), '--dbname', pgUrl], { stdio: ['ignore', out, 'inherit'] });
    fs.closeSync(out);
    if (d.status !== 0) throw new Error('pg_dump failed. Install the PostgreSQL client tools (same major version as the server).');
    const file = path.join(outDir, `arzio-backup-${stamp}.tar.gz`);
    const parts = ['attachments', 'raw'].filter((x) => fs.existsSync(path.join(dataDir, x)));
    const tar = spawnSync('tar', ['-czf', file + '.part', '-C', dataDir, path.basename(copy), ...parts], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error('tar failed');
    fs.renameSync(file + '.part', file);
    console.log(`Backup written: ${file} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB, PostgreSQL)`);
    rotate();
    process.exitCode = 0;
  } else {
    const src = new DatabaseSync(dbFile);
    src.exec('PRAGMA busy_timeout = 10000');
    src.prepare('VACUUM INTO ?').run(copy);
    src.close();
    const check = new DatabaseSync(copy, { readOnly: true });
    const ok = check.prepare('PRAGMA integrity_check').get();
    const counts = { users: check.prepare('SELECT COUNT(*) AS n FROM users').get().n, messages: check.prepare('SELECT COUNT(*) AS n FROM messages').get().n };
    check.close();
    if (Object.values(ok)[0] !== 'ok') throw new Error('Database copy failed its integrity check');

    const file = path.join(outDir, `arzio-backup-${stamp}.tar.gz`);
    const parts = ['attachments', 'raw'].filter((d) => fs.existsSync(path.join(dataDir, d)));
    const tar = spawnSync('tar', ['-czf', file + '.part', '-C', dataDir, 'snapshot.db', ...parts], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error('tar failed');
    fs.renameSync(file + '.part', file);
    const size = fs.statSync(file).size;
    console.log(`Backup written: ${file} (${(size / 1048576).toFixed(1)} MB, ${counts.users} users, ${counts.messages} messages)`);

    rotate();
  }
} finally {
  fs.rmSync(copy, { force: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.part')) fs.rmSync(path.join(outDir, f), { force: true });
}
