// End-to-end API tests: signup, local delivery, threading, search, AI fallback, tenants.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-test-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', ARZIO_ADMIN_EMAILS: 'ops@arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log' });
const { app } = await import('../src/server.js');

let base;
before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.unref();
});

function client() {
  let cookie = '';
  return async (p, body, method) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

test('signup, send, receive, thread, search, AI', async () => {
  const alice = client();
  const bob = client();
  assert.equal((await alice('/auth/signup', { username: 'alice', name: 'Alice', password: 'password123' })).status, 201);
  assert.equal((await bob('/auth/signup', { username: 'bob', name: 'Bob', password: 'password123' })).status, 201);
  assert.equal((await bob('/auth/signup', { username: 'admin', name: 'X', password: 'password123' })).status, 400, 'reserved name');

  const sent = await alice('/send', { to: 'bob@arzio.test, someone@example.com', subject: 'Lunch plan', text: 'Can you join lunch on Friday?' });
  assert.deepEqual(sent.data.deliveredLocally, ['bob@arzio.test']);
  assert.deepEqual(sent.data.sentRemotely, ['someone@example.com']);

  const inbox = (await bob('/folders')).data.folders.find((f) => f.role === 'inbox');
  const list = (await bob(`/messages?folder=${inbox.id}`)).data.messages;
  assert.equal(list.length, 1);
  const msg = (await bob(`/messages/${list[0].id}`)).data.message;
  assert.equal(msg.subject, 'Lunch plan');

  await bob('/send', { to: 'alice@arzio.test', subject: 'Re: Lunch plan', text: 'Yes!', inReplyTo: msg.message_id, references: msg.message_id });
  const aliceInbox = (await alice('/folders')).data.folders.find((f) => f.role === 'inbox');
  const reply = (await alice(`/messages?folder=${aliceInbox.id}`)).data.messages[0];
  const thread = (await alice(`/threads/${reply.thread_id}`)).data.messages;
  assert.equal(thread.length, 2, 'reply joins the sent message thread');

  assert.equal((await alice('/messages?q=lunch')).data.messages.length, 2);
  const sum = await bob('/ai/summarize', { messageId: msg.id });
  assert.equal(sum.status, 200);
  assert.ok(sum.data.summary.length > 0);
  const draft = await bob('/ai/draft', { messageId: msg.id, instructions: 'Yes, see you there' });
  assert.match(draft.data.body, /see you there/);
});

test('private organization lifecycle', async () => {
  const root = client();
  await root('/auth/signup', { username: 'ops', name: 'Ops', password: 'password123' });
  const org = await root('/admin/orgs', { name: 'Acme', domain: 'acme.example', adminUsername: 'ravi', adminName: 'Ravi', adminPassword: 'password123' });
  assert.equal(org.status, 201);

  const ravi = client();
  assert.equal((await ravi('/auth/login', { email: 'ravi@acme.example', password: 'password123' })).status, 200);
  const doms = (await ravi('/org/domains')).data.domains;
  assert.equal(doms[0].verified, false);
  assert.equal((await ravi('/org/users', { username: 'meena', domain: 'acme.example', password: 'password123' })).status, 400, 'unverified domain');
  // Service admin can force-verify (e.g. after checking DNS manually)
  assert.equal((await root(`/org/domains/${doms[0].id}/verify?org=${org.data.orgId}`, { force: true })).status, 200);
  assert.equal((await ravi('/org/users', { username: 'meena', name: 'Meena', domain: 'acme.example', password: 'password123' })).status, 201);

  const pub = client();
  await pub('/auth/signup', { username: 'carol', password: 'password123' });
  assert.equal((await pub('/org/users')).status, 403, 'public users have no org admin');
  const r = await pub('/send', { to: 'meena@acme.example', subject: 'Hi', text: 'Hello Meena' });
  assert.deepEqual(r.data.deliveredLocally, ['meena@acme.example'], 'mail between tenants is delivered locally');
});
