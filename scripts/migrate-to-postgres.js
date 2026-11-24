#!/usr/bin/env node
// Copy an Arzio Mail SQLite database into an empty PostgreSQL database.
//
//   ARZIO_DATA_DIR=/opt/arzio/data ARZIO_DB_URL=postgres://arzio:pw@db/arzio \
//     node scripts/migrate-to-postgres.js
//
// Stop the server first. Mail files (attachments, original messages) stay
// where they are; move them to S3 separately with scripts/migrate-files-to-s3.js.
// Afterwards set ARZIO_DB_URL in .env and start the server.
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const url = process.env.ARZIO_DB_URL || process.env.DATABASE_URL;
const dataDir = path.resolve(process.env.ARZIO_DATA_DIR || './data');
const file = path.join(dataDir, 'arzio.db');
if (!/^postgres(ql)?:/i.test(url || '')) { console.error('Set ARZIO_DB_URL to the PostgreSQL database (postgres://user:password@host/db).'); process.exit(1); }
if (!fs.existsSync(file)) { console.error(`No SQLite database at ${file}. Set ARZIO_DATA_DIR.`); process.exit(1); }

// 1. Create the schema in PostgreSQL by loading Arzio with the new database
await import('../src/db.js');
await import('../src/billing.js');
const { db } = await import('../src/db.js');
const schema = db.schema;
db.close();

const src = new DatabaseSync(file, { readOnly: true });
const client = new pg.Client({ connectionString: url });
await client.connect();
if (schema) await client.query(`SET search_path TO ${schema}`);
const has = (await client.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
if (has > 0) { console.error('The PostgreSQL database already has users. Migrate into an empty database.'); process.exit(1); }

// 2. Tables in an order that respects foreign keys
const tables = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%'").all().map((r) => r.name);
const deps = Object.fromEntries(tables.map((t) => [t, src.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => f.table).filter((x) => x !== t)]));
const order = [];
const visit = (t, seen = new Set()) => { if (order.includes(t) || seen.has(t)) return; seen.add(t); for (const d of deps[t] || []) if (tables.includes(d)) visit(d, seen); order.push(t); };
tables.forEach((t) => visit(t));

const pgCols = async (t) => (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [t])).rows.map((r) => r.column_name);

await client.query('BEGIN');
try {
  // Keep IMAP UIDs exactly as they are
  await client.query('ALTER TABLE messages DISABLE TRIGGER trg_messages_uid_insert');
  // The new database only holds starting rows (such as the default plans): clear them
  for (const t of [...order].reverse()) if ((await pgCols(t)).length) await client.query(`DELETE FROM ${t}`);
  await client.query('DELETE FROM messages_fts');
  for (const t of order) {
    const target = await pgCols(t);
    if (!target.length) { console.warn(`skip ${t} (not in PostgreSQL schema)`); continue; }
    const cols = src.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).filter((c) => target.includes(c));
    let n = 0;
    const rows = src.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${t}`).all();
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const values = []; const params = [];
      for (const r of batch) {
        values.push(`(${cols.map((c) => { params.push(r[c]); return `$${params.length}`; }).join(', ')})`);
      }
      await client.query(`INSERT INTO ${t} (${cols.join(', ')}) VALUES ${values.join(', ')}`, params);
      n += batch.length;
    }
    if (target.includes('id')) await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 0), 1))`);
    console.log(`${t}: ${n}`);
  }
  // Search index
  const fts = src.prepare('SELECT rowid, subject, body, people FROM messages_fts').all();
  for (let i = 0; i < fts.length; i += 500) {
    const batch = fts.slice(i, i + 500);
    const params = [];
    const values = batch.map((r) => { params.push(r.rowid, r.subject || '', r.body || '', r.people || ''); const k = params.length; return `($${k - 3}, $${k - 2}, $${k - 1}, $${k})`; });
    await client.query(`INSERT INTO messages_fts (rowid, subject, body, people) VALUES ${values.join(', ')}`, params);
  }
  console.log(`search index: ${fts.length}`);
  await client.query('ALTER TABLE messages ENABLE TRIGGER trg_messages_uid_insert');
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('Migration failed, nothing was changed:', e.message);
  process.exit(1);
}
await client.end();
console.log('Done. Set ARZIO_DB_URL in .env and start Arzio Mail.');
