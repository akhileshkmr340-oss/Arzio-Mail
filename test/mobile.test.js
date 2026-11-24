// What the phone app needs from the server: header sessions and push notifications.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// A stand-in for the Expo push service
const pushed = [];
const pushServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const msgs = JSON.parse(body);
    pushed.push(...msgs);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: msgs.map((m) => (m.to.includes('GONE') ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' })) }));
  });
});
await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-mob-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log', ARZIO_PUSH_URL: `http://127.0.0.1:${pushServer.address().port}/push` });
const { app } = await import('../src/server.js');

let base;
const call = async (p, { body, method, session } = {}) => {
  const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(session ? { 'x-arzio-session': session } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie') };
};
const waitFor = async (fn) => { for (let i = 0; i < 50; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.unref();
  await call('/auth/signup', { body: { username: 'zoya', name: 'Zoya Khan', password: 'password123' } });
  await call('/auth/signup', { body: { username: 'omar', name: 'Omar Ali', password: 'password123' } });
});
after(() => pushServer.close());

test('the app signs in with a session it keeps, not a cookie', async () => {
  const bad = await call('/auth/login', { body: { email: 'zoya@arzio.test', password: 'nope', client: 'app' } });
  assert.equal(bad.status, 401);
  const r = await call('/auth/login', { body: { email: 'zoya@arzio.test', password: 'password123', client: 'app', device: 'Pixel 9' } });
  assert.equal(r.status, 200);
  assert.ok(r.data.session && r.data.expires);
  assert.equal(r.cookie, null, 'no cookie for the app');
  const me = await call('/me', { session: r.data.session });
  assert.equal(me.status, 200);
  assert.equal((me.data.user || me.data).email, 'zoya@arzio.test');
  // Full account rights, unlike API tokens: it can change preferences
  assert.equal((await call('/me/preferences', { body: { undo_send_seconds: 0 }, method: 'PATCH', session: r.data.session })).status, 200);
  await call('/auth/logout', { body: {}, session: r.data.session });
  assert.equal((await call('/me', { session: r.data.session })).status, 401, 'signed out');
});

test('push: new mail reaches the phone; stale tokens are dropped', async () => {
  const z = (await call('/auth/login', { body: { email: 'zoya@arzio.test', password: 'password123', client: 'app' } })).data.session;
  const o = (await call('/auth/login', { body: { email: 'omar@arzio.test', password: 'password123', client: 'app' } })).data.session;
  await call('/me/preferences', { body: { undo_send_seconds: 0 }, method: 'PATCH', session: o });
  assert.equal((await call('/me/push-tokens', { body: { token: 'not-a-token' }, session: z })).status, 400);
  assert.equal((await call('/me/push-tokens', { body: { token: 'ExponentPushToken[zoyaPhone123456]', platform: 'android', deviceName: 'Pixel 9' }, session: z })).status, 201);
  assert.equal((await call('/me/push-tokens', { body: { token: 'ExponentPushToken[GONE-old-phone-1]', platform: 'ios' }, session: z })).status, 201);

  await call('/send', { body: { to: 'zoya@arzio.test', subject: 'Train tickets', text: 'Booked for Friday' }, session: o });
  assert.ok(await waitFor(() => pushed.some((m) => m.body === 'Train tickets')));
  const m = pushed.find((x) => x.to === 'ExponentPushToken[zoyaPhone123456]');
  assert.equal(m.title, 'Omar Ali');
  assert.equal(m.data.type, 'mail');
  assert.ok(m.data.messageId);
  // The token Expo called "not registered" is gone; the other stays
  await new Promise((r) => setTimeout(r, 100));
  const { db } = await import('../src/db.js');
  assert.deepEqual(db.prepare('SELECT token FROM push_tokens ORDER BY id').all().map((r) => r.token), ['ExponentPushToken[zoyaPhone123456]']);

  // Only the recipient's phones are notified
  const before = pushed.length;
  await call('/send', { body: { to: 'omar@arzio.test', subject: 'Reply', text: 'ok' }, session: z });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pushed.length, before, 'Omar has no phone registered');

  // Signing out on the phone removes its token
  await call('/me/push-tokens', { body: { token: 'ExponentPushToken[zoyaPhone123456]' }, method: 'DELETE', session: z });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_tokens').get().n, 0);
});

test('forwarding from the app keeps the original attachments', async () => {
  const z = (await call('/auth/login', { body: { email: 'zoya@arzio.test', password: 'password123', client: 'app' } })).data.session;
  const o = (await call('/auth/login', { body: { email: 'omar@arzio.test', password: 'password123', client: 'app' } })).data.session;
  await call('/me/preferences', { body: { undo_send_seconds: 0 }, method: 'PATCH', session: z });
  await call('/send', { body: { to: 'zoya@arzio.test', subject: 'Floor plan', text: 'See attached', attachments: [{ filename: 'plan.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF plan').toString('base64') }] }, session: o });
  const inbox = (await call('/folders', { session: z })).data.folders.find((f) => f.role === 'inbox');
  const orig = (await call(`/messages?folder=${inbox.id}`, { session: z })).data.messages.find((m) => m.subject === 'Floor plan');
  assert.equal((await call('/send', { body: { to: 'omar@arzio.test', subject: 'Fwd: Floor plan', text: 'FYI', forwardOf: orig.id, attachments: [{ filename: 'notes.txt', contentType: 'text/plain', contentBase64: Buffer.from('mine').toString('base64') }] }, session: z })).status, 200);
  const oInbox = (await call('/folders', { session: o })).data.folders.find((f) => f.role === 'inbox');
  const fw = (await call(`/messages?folder=${oInbox.id}`, { session: o })).data.messages.find((m) => m.subject === 'Fwd: Floor plan');
  const full = (await call(`/messages/${fw.id}`, { session: o })).data.message;
  assert.deepEqual(full.attachments.map((a) => a.filename).sort(), ['notes.txt', 'plan.pdf']);
  // Someone else's message id cannot be forwarded
  const other = (await call(`/messages?folder=${oInbox.id}`, { session: o })).data.messages[0];
  await call('/send', { body: { to: 'omar@arzio.test', subject: 'Sneaky', text: 'x', forwardOf: other.id }, session: z });
  const sneaky = (await call(`/messages?folder=${oInbox.id}`, { session: o })).data.messages.find((m) => m.subject === 'Sneaky');
  assert.equal((await call(`/messages/${sneaky.id}`, { session: o })).data.message.attachments.length, 0);
});
