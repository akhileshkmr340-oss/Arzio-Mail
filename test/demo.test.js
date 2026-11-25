// Public demo mode: mail moves inside the demo, and outside addresses are refused with a clear reason.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-demo-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', ARZIO_DEMO: 'true', ARZIO_PUSH: 'off' });
const { app } = await import('../src/server.js');
const { seedDemo } = await import('../src/demo.js');

let base;
let session;
const call = async (p, body) => {
  const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(session ? { 'x-arzio-session': session } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

before(async () => {
  await seedDemo();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.unref();
  session = (await call('/auth/login', { email: 'demo@arzio.test', password: 'ArzioDemo2026', client: 'app' })).data.session;
  await fetch(base + '/me/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-arzio-session': session }, body: JSON.stringify({ undo_send_seconds: 0 }) });
});

test('mail to an outside address is refused with a clear reason', async () => {
  const r = await call('/send', { to: 'someone@gmail.com', subject: 'Hi', text: 'Hello' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /only send to addresses ending in @arzio\.test/);
  assert.match(r.data.error, /someone@gmail\.com/);
});

test('mail inside the demo arrives', async () => {
  const r = await call('/send', { to: 'demo@arzio.test', subject: 'Inside the demo', text: 'Hello' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { folders } = (await call('/folders')).data;
  const inbox = folders.find((f) => f.role === 'inbox');
  const { messages } = (await call(`/messages?folder=${inbox.id}`)).data;
  assert.ok(messages.some((m) => m.subject === 'Inside the demo'));
});
