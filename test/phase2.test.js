// Phase 2: rules, automatic replies, undo/scheduled send, snooze, junk, MFA,
// aliases, bounces, contacts, sweep, AI coaching and Q&A, delegation.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-p2-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log' });
const { app } = await import('../src/server.js');
const { runWorkersOnce } = await import('../src/mail/delivery.js');
const { totp } = await import('../src/mfa.js');
const { db } = await import('../src/db.js');

let base;
let alice; let bob;
before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.unref();
  alice = await signup('alice');
  bob = await signup('bob');
});

function client() {
  let cookie = '';
  const fn = async (p, body, method, headers = {}) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  return fn;
}

async function signup(name) {
  const c = client();
  const r = await c('/auth/signup', { username: name, name: name[0].toUpperCase() + name.slice(1), password: 'password123' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await c('/me/preferences', { undo_send_seconds: 0 }, 'PATCH');
  return c;
}
const folder = async (c, role) => (await c('/folders')).data.folders.find((f) => f.role === role);
const inboxMsgs = async (c) => (await c(`/messages?folder=${(await folder(c, 'inbox')).id}&limit=100`)).data.messages;


test('inbox rules move, flag and categorize', async () => {
  const f = (await bob('/folders', { name: 'Invoices' })).data.folder;
  const r = await bob('/rules', { name: 'Invoices', conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }], actions: [{ type: 'move', value: f.id }, { type: 'flag' }, { type: 'category', value: 'Finance' }] });
  assert.equal(r.status, 201);
  await alice('/send', { to: 'bob@arzio.test', subject: 'Invoice #42', text: 'Please find the invoice.' });
  const moved = (await bob(`/messages?folder=${f.id}`)).data.messages;
  assert.equal(moved.length, 1);
  assert.equal(moved[0].is_flagged, true);
  assert.deepEqual(moved[0].categories, ['Finance']);
});

test('automatic replies are sent once per sender', async () => {
  await bob('/me/preferences', { ooo_enabled: true, ooo_message: 'I am on leave until Monday.' }, 'PATCH');
  await alice('/send', { to: 'bob@arzio.test', subject: 'Question 1', text: 'Hi' });
  await alice('/send', { to: 'bob@arzio.test', subject: 'Question 2', text: 'Hi again' });
  await new Promise((r) => setTimeout(r, 200));
  const autos = (await inboxMsgs(alice)).filter((m) => /on leave/.test(m.snippet));
  assert.equal(autos.length, 1);
  await bob('/me/preferences', { ooo_enabled: false }, 'PATCH');
});

test('undo send and scheduled send', async () => {
  await alice('/me/preferences', { undo_send_seconds: 10 }, 'PATCH');
  const q = await alice('/send', { to: 'bob@arzio.test', subject: 'Oops', text: 'Wrong person' });
  assert.equal(q.data.queued, true);
  const undo = await alice(`/outbox/${q.data.outboxId}/cancel`, {});
  assert.equal(undo.data.draft.subject, 'Oops');
  const later = new Date(Date.now() + 3600e3).toISOString();
  const s = await alice('/send', { to: 'bob@arzio.test', subject: 'Scheduled hello', text: 'Sent later', sendAt: later });
  assert.equal(s.data.scheduled, true);
  assert.equal((await alice('/outbox')).data.items.length, 1);
  // Make it due and run the worker
  db.prepare('UPDATE outbox SET send_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.data.outboxId);
  await runWorkersOnce();
  assert.ok((await inboxMsgs(bob)).some((m) => m.subject === 'Scheduled hello'));
  assert.ok(!(await inboxMsgs(bob)).some((m) => m.subject === 'Oops'));
  await alice('/me/preferences', { undo_send_seconds: 0 }, 'PATCH');
});

test('snooze hides a message until its time', async () => {
  await alice('/send', { to: 'bob@arzio.test', subject: 'Snooze me', text: 'Later' });
  const m = (await inboxMsgs(bob)).find((x) => x.subject === 'Snooze me');
  await bob(`/messages/${m.id}`, { snooze_until: new Date(Date.now() + 3600e3).toISOString(), is_read: true }, 'PATCH');
  assert.ok(!(await inboxMsgs(bob)).some((x) => x.id === m.id));
  assert.equal((await bob('/messages?snoozed=1')).data.messages.length, 1);
  db.prepare('UPDATE messages SET snooze_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), m.id);
  await runWorkersOnce();
  const back = (await inboxMsgs(bob)).find((x) => x.id === m.id);
  assert.ok(back && back.is_read === false);
});

test('blocked senders go to Junk; reporting not-junk marks safe', async () => {
  const carol = await signup('carol');
  await bob('/senders', { address: 'carol@arzio.test', kind: 'blocked' });
  await carol('/send', { to: 'bob@arzio.test', subject: 'Buy now', text: 'spam' });
  const junk = (await bob(`/messages?folder=${(await folder(bob, 'junk')).id}`)).data.messages;
  assert.equal(junk.length, 1);
  await bob(`/messages/${junk[0].id}/report`, { junk: false });
  await carol('/send', { to: 'bob@arzio.test', subject: 'Real mail', text: 'hello' });
  assert.ok((await inboxMsgs(bob)).some((m) => m.subject === 'Real mail'));
});

test('two-step verification', async () => {
  const dave = await signup('dave');
  const setup = await dave('/me/mfa/setup', {});
  assert.match(setup.data.qr, /^data:image\/png;base64,/);
  assert.equal((await dave('/me/mfa/enable', { code: '000000' })).status, 400);
  assert.equal((await dave('/me/mfa/enable', { code: totp(setup.data.secret) })).status, 200);
  const c = client();
  const r1 = await c('/auth/login', { email: 'dave', password: 'password123' });
  assert.equal(r1.status, 401);
  assert.equal(r1.data.mfaRequired, true);
  const r2 = await c('/auth/login', { email: 'dave', password: 'password123', code: totp(setup.data.secret) });
  assert.equal(r2.status, 200);
});

test('aliases receive mail and can be sent from', async () => {
  const a = await alice('/me/aliases', { username: 'alice.work' });
  assert.equal(a.status, 201);
  await bob('/send', { to: 'alice.work@arzio.test', subject: 'To alias', text: 'x' });
  assert.ok((await inboxMsgs(alice)).some((m) => m.subject === 'To alias'));
  const r = await alice('/send', { from: 'alice.work@arzio.test', to: 'bob@arzio.test', subject: 'From alias', text: 'y' });
  assert.equal(r.status, 200);
  assert.equal((await inboxMsgs(bob)).find((m) => m.subject === 'From alias').from_addr, 'alice.work@arzio.test');
  assert.equal((await alice('/send', { from: 'bob@arzio.test', to: 'x@example.com', text: 'z' })).status, 403);
  // plus addressing
  await bob('/send', { to: 'alice+news@arzio.test', subject: 'Plus address', text: 'p' });
  assert.ok((await inboxMsgs(alice)).some((m) => m.subject === 'Plus address'));
});

test('permanent remote failure produces a bounce notice', async () => {
  await alice('/send', { to: 'nobody@fail.test', subject: 'Will bounce', text: 'x' });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok((await inboxMsgs(alice)).some((m) => m.subject === 'Undeliverable: Will bounce'));
});

test('contacts: auto-collected, autocomplete, saved, vCard', async () => {
  const s = await alice('/contacts/suggest?q=bo');
  assert.ok(s.data.suggestions.some((c) => c.email === 'bob@arzio.test'));
  const c = await alice('/contacts', { email: 'ravi@example.com', name: 'Ravi Kumar', company: 'Acme', phone: '+91 98765 43210' });
  assert.equal(c.status, 201);
  assert.equal((await alice('/contacts?q=ravi')).data.contacts.length, 1);
  const v = await fetch(base + '/contacts.vcf', { headers: { cookie: '' } });
  assert.equal(v.status, 401);
});

test('sweep moves everything from a sender', async () => {
  const before = (await inboxMsgs(bob)).filter((m) => m.from_addr === 'alice@arzio.test').length;
  assert.ok(before > 0);
  const r = await bob('/messages/sweep', { sender: 'alice@arzio.test', action: 'archive' });
  assert.equal(r.data.moved, before);
  assert.equal((await inboxMsgs(bob)).filter((m) => m.from_addr === 'alice@arzio.test').length, 0);
});

test('AI coaching and ask your mailbox (built-in fallback)', async () => {
  const c = await alice('/ai/coach', { text: 'PLEASE SEE THE ATTACHED FILE' });
  assert.equal(c.data.verdict, 'review');
  const a = await bob('/ai/ask', { question: 'what was the invoice about?' });
  assert.ok(a.data.sources.some((s) => /Invoice/.test(s.subject)));
});

test('delegation lets another user open a mailbox and send on behalf', async () => {
  await bob('/me/delegates', { email: 'alice@arzio.test', permission: 'send_on_behalf' });
  const boxes = (await alice('/me/mailboxes')).data.mailboxes;
  const bobBox = boxes.find((b) => b.email === 'bob@arzio.test');
  assert.ok(bobBox);
  const list = await alice('/folders', undefined, 'GET', { 'x-arzio-mailbox': String(bobBox.id) });
  assert.equal(list.status, 200);
  const r = await alice('/send', { from: 'bob@arzio.test', to: 'carol@arzio.test', subject: 'On behalf', text: 'x' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sent = (await bob(`/messages?folder=${(await folder(bob, 'sent')).id}`)).data.messages;
  assert.ok(sent.some((m) => m.subject === 'On behalf'), 'copy lands in the owner\'s Sent Items');
  // A user without delegation cannot open the mailbox
  const carol = client();
  await carol('/auth/login', { email: 'carol', password: 'password123' });
  assert.equal((await carol('/folders', undefined, 'GET', { 'x-arzio-mailbox': String(bobBox.id) })).status, 403);
});
