// S3-compatible storage for attachments and original messages, plus the
// AWS Signature V4 signer checked against AWS's published example.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { signV4 } from '../src/sql/s3-handler.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-s3-'));
const s3dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-s3data-'));
// A local S3-compatible server in its own process (Arzio's storage calls block
// the main thread, so the server cannot share it)
const s3 = spawn(process.execPath, ['--input-type=module', '-e', `
  import S3rver from 's3rver';
  const s = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: ${JSON.stringify(s3dir)}, configureBuckets: [{ name: 'arzio-mail' }] });
  const { port } = await s.run();
  console.log('PORT ' + port);
`], { stdio: ['ignore', 'pipe', 'inherit'], cwd: path.dirname(new URL(import.meta.url).pathname) });
const port = await new Promise((resolve) => s3.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));

Object.assign(process.env, {
  ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log',
  ARZIO_S3_BUCKET: 'arzio-mail', ARZIO_S3_ENDPOINT: `http://127.0.0.1:${port}`, ARZIO_S3_REGION: 'us-east-1',
  ARZIO_S3_ACCESS_KEY: 'S3RVER', ARZIO_S3_SECRET_KEY: 'S3RVER', ARZIO_S3_PATH_STYLE: 'true', ARZIO_S3_PREFIX: 'mail',
});
const { app } = await import('../src/server.js');
const blobs = await import('../src/blobs.js');

let base;
function client() {
  let cookie = '';
  return async (p, body, method) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}

before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.unref();
});
after(() => s3.kill());

test('Signature V4 matches the AWS documentation example', () => {
  // "Example: GET Object" from the Amazon S3 Signature Version 4 documentation
  const { signature } = signV4({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
    headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    region: 'us-east-1', accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('attachments and original messages live in the bucket', async () => {
  assert.equal(blobs.backend, 's3');
  const a = client(); const b = client();
  await a('/auth/signup', { username: 'ana', name: 'Ana', password: 'password123' });
  await b('/auth/signup', { username: 'ben', name: 'Ben', password: 'password123' });
  await a('/me/preferences', { undo_send_seconds: 0 }, 'PATCH');
  const pdf = Buffer.from('%PDF-1.4 fake invoice content ' + 'x'.repeat(5000));
  const s = await a('/send', { to: 'ben@arzio.test', subject: 'Invoice attached', text: 'See the PDF', attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', contentBase64: pdf.toString('base64') }] });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const folders = (await b('/folders')).data.folders;
  const inbox = folders.find((f) => f.role === 'inbox');
  const msg = (await b(`/messages?folder=${inbox.id}`)).data.messages.find((m) => m.subject === 'Invoice attached');
  const full = (await b(`/messages/${msg.id}`)).data.message;
  assert.equal(full.attachments.length, 1);
  const dl = await b(`/attachments/${full.attachments[0].id}`);
  assert.equal(dl.status, 200);
  assert.ok(dl.data.equals(pdf), 'downloaded bytes match');

  // Files are in the bucket, not on the server's disk
  const { db } = await import('../src/db.js');
  const att = db.prepare('SELECT storage_path FROM attachments WHERE id = ?').get(full.attachments[0].id);
  assert.match(att.storage_path, /^s3:\/\/arzio-mail\/mail\/attachments\//);
  const raw = db.prepare('SELECT raw_path FROM messages WHERE id = ?').get(msg.id);
  assert.match(raw.raw_path, /^s3:\/\/arzio-mail\/mail\/raw\//);
  assert.match(blobs.get(raw.raw_path).toString(), /Subject: Invoice attached/);
  assert.equal(fs.readdirSync(path.join(dir, 'attachments')).length, 0);

  // Deleting for good removes the objects
  await b(`/messages/${msg.id}`, null, 'DELETE');
  await b(`/messages/${msg.id}`, null, 'DELETE');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(blobs.exists(att.storage_path), false);
  assert.equal(blobs.exists(raw.raw_path), false);
});
