// Connected accounts: a mailbox at another provider (here Arzio's own IMAP and
// SMTP submission servers stand in for Hostinger) is synced into its own folder
// and mail sent "From" it goes through that provider's SMTP server.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-connected-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log', IMAP_PORT: '0', SUBMISSION_PORT: '0', ARZIO_IMPORT_ALLOW_PRIVATE: '1' });
const { app } = await import('../src/server.js');
const { startImap } = await import('../src/mail/imap.js');
const { startSubmission } = await import('../src/mail/smtp-submission.js');
const { db } = await import('../src/db.js');
const { encrypt, decrypt, syncAllOnce } = await import('../src/mail/connected.js');

let base;
let alice; let enquiry; let dave;
let imapPort; let smtpPort;

function client() {
  let cookie = '';
  return async (p, body, method) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}
async function signup(name) {
  const c = client();
  const r = await c('/auth/signup', { username: name, name: name[0].toUpperCase() + name.slice(1), password: 'password123' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await c('/me/preferences', { undo_send_seconds: 0 }, 'PATCH');
  return c;
}
const folderNamed = async (c, name) => (await c('/folders')).data.folders.find((f) => f.name === name);
const folderRole = async (c, role) => (await c('/folders')).data.folders.find((f) => f.role === role);
const msgs = async (c, f) => (await c(`/messages?folder=${f.id}&limit=100`)).data.messages;

before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.unref();
  const imap = startImap();
  const smtp = startSubmission();
  await new Promise((r) => (imap.listening ? r() : imap.once('listening', r)));
  await new Promise((r) => setTimeout(r, 100));
  imapPort = imap.address().port;
  smtpPort = smtp.server.address().port;
  imap.unref();
  smtp.server.unref();
  alice = await signup('alice');
  enquiry = await signup('enquiry'); // plays the Hostinger mailbox
  dave = await signup('dave');
});

const account = () => ({ address: 'enquiry@arzio.test', name: 'AR Foods Enquiry', imapHost: '127.0.0.1', imapPort, imapSecure: false, smtpHost: '127.0.0.1', smtpPort, smtpSecure: false, password: 'password123' });

test('passwords are stored encrypted', () => {
  const blob = encrypt('s3cret!');
  assert.ok(!blob.includes('s3cret'));
  assert.equal(decrypt(blob), 's3cret!');
});

test('a wrong password is reported and nothing is saved', async () => {
  const r = await alice('/me/connected', { ...account(), password: 'wrong' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Could not sign in/);
  assert.equal((await alice('/me/connected')).data.accounts.length, 0);
});

test('connect, sync existing and new mail, send as the account', async () => {
  await dave('/send', { to: 'enquiry@arzio.test', subject: 'Price list please', text: 'Hi, can you send your price list?' });

  const r = await alice('/me/connected', account());
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.account.address, 'enquiry@arzio.test');
  assert.equal(r.data.account.password_enc, undefined);
  assert.equal(r.data.account.imported, 1);
  const row = db.prepare('SELECT password_enc FROM connected_accounts').get();
  assert.ok(!row.password_enc.includes('password123'));

  // Existing mail landed in a folder named after the account
  const f = await folderNamed(alice, 'enquiry@arzio.test');
  assert.ok(f);
  assert.deepEqual((await msgs(alice, f)).map((m) => m.subject), ['Price list please']);

  // Same address twice is refused
  assert.equal((await alice('/me/connected', account())).status, 409);

  // New mail arrives on the next sync, without duplicates
  await dave('/send', { to: 'enquiry@arzio.test', subject: 'Bulk order', text: '200 kg please' });
  const s = await alice(`/me/connected/${r.data.account.id}/sync`, {});
  assert.equal(s.data.imported, 1);
  assert.equal((await alice(`/me/connected/${r.data.account.id}/sync`, {})).data.imported, 0);
  assert.equal((await msgs(alice, f)).length, 2);

  // The account is offered as a From address
  const ids = (await alice('/me/identities')).data.identities;
  assert.ok(ids.some((i) => i.address === 'enquiry@arzio.test' && i.name === 'AR Foods Enquiry'));

  // Sending as it goes through the account's SMTP server
  const sent = await alice('/send', { from: 'enquiry@arzio.test', to: 'dave@arzio.test', subject: 'Re: Price list please', text: 'Attached is our price list.' });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.transport, 'connected');
  const got = (await msgs(dave, await folderRole(dave, 'inbox'))).find((m) => m.subject === 'Re: Price list please');
  assert.ok(got, 'dave received the reply');
  assert.equal(got.from_addr, 'enquiry@arzio.test');
  // A copy is kept in Alice's Sent Items and in the account's own Sent folder
  assert.ok((await msgs(alice, await folderRole(alice, 'sent'))).some((m) => m.subject === 'Re: Price list please'));
  await new Promise((res) => setTimeout(res, 300));
  assert.ok((await msgs(enquiry, await folderRole(enquiry, 'sent'))).some((m) => m.subject === 'Re: Price list please'));

  // The background sync keeps working and marks the account healthy
  db.prepare("UPDATE connected_accounts SET last_sync_at = datetime('now', '-1 hour')").run();
  await syncAllOnce();
  assert.equal((await alice('/me/connected')).data.accounts[0].status, 'ok');

  // Other users cannot send as it, see it or sync it
  assert.equal((await dave('/send', { from: 'enquiry@arzio.test', to: 'alice@arzio.test', subject: 'x', text: 'x' })).status, 403);
  assert.equal((await dave(`/me/connected/${r.data.account.id}/sync`, {})).status, 404);
  assert.equal((await dave('/me/connected')).data.accounts.length, 0);

  // Disconnect keeps the copied mail
  assert.equal((await alice(`/me/connected/${r.data.account.id}`, null, 'DELETE')).status, 200);
  assert.equal((await msgs(alice, f)).length, 2);
  assert.ok(!(await alice('/me/identities')).data.identities.some((i) => i.address === 'enquiry@arzio.test'));
});
