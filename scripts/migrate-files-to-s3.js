#!/usr/bin/env node
// Move attachments and original messages from the data folder to the S3
// bucket set in ARZIO_S3_*. Safe to run while the server runs, and safe to
// run again: only files still on disk are moved. Local files are removed
// after upload only with --delete.
//
//   ARZIO_S3_BUCKET=... ARZIO_S3_ACCESS_KEY=... ARZIO_S3_SECRET_KEY=... node scripts/migrate-files-to-s3.js [--delete]
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.ARZIO_S3_BUCKET) { console.error('Set ARZIO_S3_BUCKET and the other ARZIO_S3_* settings first.'); process.exit(1); }
const del = process.argv.includes('--delete');
const { db } = await import('../src/db.js');
const blobs = await import('../src/blobs.js');

let moved = 0; let missing = 0;
function move(table, col, kind) {
  const rows = db.prepare(`SELECT id, ${col} AS ref FROM ${table} WHERE ${col} IS NOT NULL AND ${col} NOT LIKE 's3://%'`).all();
  for (const r of rows) {
    if (!fs.existsSync(r.ref)) { missing++; continue; }
    const ref = blobs.put(kind, path.basename(r.ref), fs.readFileSync(r.ref));
    db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(ref, r.id);
    if (del) fs.rmSync(r.ref, { force: true });
    moved++;
    if (moved % 500 === 0) console.log(`${moved} files moved`);
  }
}
move('attachments', 'storage_path', 'attachments');
move('messages', 'raw_path', 'raw');
move('delivery_queue', 'raw_path', 'queue');
console.log(`Done: ${moved} files moved to the bucket${missing ? `, ${missing} were already missing on disk` : ''}.${del ? '' : ' Local copies kept; run again with --delete to remove them.'}`);
