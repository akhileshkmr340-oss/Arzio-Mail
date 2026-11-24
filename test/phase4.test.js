// Phase 4: shared mailboxes, groups, mail flow rules and DLP, message trace,
// retention, litigation hold, eDiscovery, audit log, reports, mail import.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-p4-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', ARZIO_ADMIN_EMAILS: 'ops@arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log', IMAP_PORT: '0', ARZIO_IMPORT_ALLOW_PRIVATE: '1' });
const { app } = await import('../src/server.js');
const { startImap } = await import('../src/mail/imap.js');

let base; let imapPort;
let boss; let ann; let raj; let outsider;
function client() {
  let cookie = '';
  return async (p, body, method, headers = {}) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
}
async function login(email) {
  const c = client();
  const r = await c('/auth/login', { email, password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c('/me/preferences', { undo_send_seconds: 0 }, 'PATCH');
  return c;
}
const folder = async (c, role, h) => (await c('/folders', null, 'GET', h)).data.folders.find((f) => f.role === role);
const inbox = async (c, h = {}) => (await c(`/messages?folder=${(await folder(c, 'inbox', h)).id}&limit=100`, null, 'GET', h)).data.messages;

before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.unref();
  const imap = startImap();
  await new Promise((r) => (imap.listening ? r() : imap.once('listening', r)));
  imapPort = imap.address().port;
  imap.unref();

  const ops = client();
  assert.equal((await ops('/auth/signup', { username: 'ops', name: 'Ops', password: 'password123' })).status, 201);
  const org = await ops('/admin/orgs', { name: 'Acme', domain: 'acme.test', adminUsername: 'boss', adminName: 'Boss', adminPassword: 'password123', maxUsers: 20 });
  const doms = (await ops(`/org/domains?org=${org.data.orgId}`)).data.domains;
  await ops(`/org/domains/${doms[0].id}/verify?org=${org.data.orgId}`, { force: true });
  boss = await login('boss@acme.test');
  for (const u of ['ann', 'raj', 'legal']) assert.equal((await boss('/org/users', { username: u, name: u, domain: 'acme.test', password: 'password123' })).status, 201);
  ann = await login('ann@acme.test');
  raj = await login('raj@acme.test');
  outsider = client();
  await outsider('/auth/signup', { username: 'zed', name: 'Zed', password: 'password123' });
  await outsider('/me/preferences', { undo_send_seconds: 0 }, 'PATCH');
});

test('shared mailbox: members open it and send as it', async () => {
  const r = await boss('/org/shared-mailboxes', { username: 'helpdesk', domain: 'acme.test', name: 'Acme Support', members: [{ email: 'ann@acme.test', permission: 'send_as' }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const list = (await boss('/org/shared-mailboxes')).data.mailboxes;
  assert.equal(list[0].members[0].email, 'ann@acme.test');
  assert.ok(!(await boss('/org/users')).data.users.some((u) => u.email === 'helpdesk@acme.test'), 'shared mailboxes are listed separately');
  assert.equal((await client()('/auth/login', { email: 'helpdesk@acme.test', password: 'x' })).status, 401);

  await outsider('/send', { to: 'helpdesk@acme.test', subject: 'Help please', text: 'My order is late' });
  const mbx = (await ann('/me/mailboxes')).data.mailboxes.find((m) => m.email === 'helpdesk@acme.test');
  const h = { 'x-arzio-mailbox': String(mbx.id) };
  assert.ok((await inbox(ann, h)).some((m) => m.subject === 'Help please'));
  assert.equal((await raj('/folders', null, 'GET', h)).status, 403, 'non-members cannot open it');
  await ann('/send', { from: 'helpdesk@acme.test', to: 'zed@arzio.test', subject: 'Re: Help please', text: 'Shipped today' });
  const got = (await inbox(outsider)).find((m) => m.subject === 'Re: Help please');
  assert.equal(got.from_addr, 'helpdesk@acme.test');
});

test('groups deliver to members; outside senders only when allowed', async () => {
  const g = await boss('/org/groups', { name: 'Sales', username: 'sales', domain: 'acme.test', members: ['ann@acme.test', 'raj@acme.test'] });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  await ann('/send', { to: 'sales@acme.test', subject: 'Team target', text: 'Q4 target is 120' });
  assert.ok((await inbox(raj)).some((m) => m.subject === 'Team target'));
  await outsider('/send', { to: 'sales@acme.test', subject: 'Cold pitch', text: 'buy' });
  assert.ok(!(await inbox(raj)).some((m) => m.subject === 'Cold pitch'));
  await boss(`/org/groups/${g.data.group.id}`, { allow_external: true }, 'PUT');
  await outsider('/send', { to: 'sales@acme.test', subject: 'Partner intro', text: 'hello' });
  assert.ok((await inbox(raj)).some((m) => m.subject === 'Partner intro'));
});

test('mail flow rules: DLP block, compliance copy, disclaimer', async () => {
  const types = (await boss('/org/sensitive-types')).data.types.map((t) => t.id);
  assert.ok(types.includes('credit_card') && types.includes('aadhaar'));
  assert.equal((await boss('/org/transport-rules', { name: 'No card numbers outside', action: 'block', value: 'Card numbers cannot be emailed outside Acme.', match: { externalRecipients: true, sensitiveInfo: ['credit_card'] } })).status, 201);
  assert.equal((await boss('/org/transport-rules', { name: 'Copy legal', action: 'bcc', value: 'legal@acme.test', match: { subjectContains: 'contract' } })).status, 201);
  const blocked = await ann('/send', { to: 'zed@arzio.test', subject: 'Payment', text: 'Use card 4111 1111 1111 1111 exp 12/30' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /Card numbers/);
  assert.equal((await ann('/send', { to: 'raj@acme.test', subject: 'Payment', text: 'Use card 4111 1111 1111 1111' })).status, 200, 'internal is fine');
  assert.equal((await ann('/send', { to: 'zed@arzio.test', subject: 'Order', text: 'Order 4111 1111 1111 1112' })).status, 200, 'not a valid card number');
  await ann('/send', { to: 'zed@arzio.test', subject: 'Draft contract', text: 'See terms' });
  const legal = await login('legal@acme.test');
  assert.ok((await inbox(legal)).some((m) => m.subject === 'Draft contract'), 'legal got a copy');
});

test('message trace shows sent, received and junk', async () => {
  const t = (await boss('/org/message-trace?q=help')).data.trace;
  assert.ok(t.some((e) => e.direction === 'Received' && e.subject === 'Help please'));
  const all = (await boss('/org/message-trace')).data.trace;
  assert.ok(all.some((e) => e.direction === 'Sent' && e.subject === 'Team target'));
  assert.equal((await ann('/org/message-trace')).status, 403, 'users cannot trace');
});

test('litigation hold keeps deleted mail for eDiscovery; export as mbox', async () => {
  assert.equal((await boss('/org/compliance', { retention_days: 5 }, 'PATCH')).status, 400);
  assert.equal((await boss('/org/compliance', { retention_days: 365, litigation_hold: true }, 'PATCH')).data.litigation_hold, true);
  await raj('/send', { to: 'ann@acme.test', subject: 'Secret pricing', text: 'Discount of 40 percent for Globex' });
  const msg = (await inbox(ann)).find((m) => m.subject === 'Secret pricing');
  await ann(`/messages/${msg.id}`, null, 'DELETE');
  await ann(`/messages/${msg.id}`, null, 'DELETE');
  assert.ok(!(await ann('/messages?q=globex')).data.messages.some((m) => m.subject === 'Secret pricing' && m.id === msg.id), 'gone for the user');
  const found = (await boss('/org/ediscovery/search', { q: 'globex' })).data;
  assert.ok(found.results.some((r) => r.mailbox === 'ann@acme.test' && r.held), 'still held');
  const mbox = await fetch(`${base}/org/ediscovery/export`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: '' }, body: '{}' });
  assert.equal(mbox.status, 401);
  const ex = await boss('/org/ediscovery/export', { q: 'globex' });
  assert.match(ex.data, /^From /);
  assert.match(ex.data, /Discount of 40 percent/);
  await boss('/org/compliance', { litigation_hold: false }, 'PATCH');
});

test('audit log and reports for admins', async () => {
  const a = (await boss('/org/audit?action=admin.')).data.entries;
  assert.ok(a.some((e) => e.action === 'admin.compliance.update'));
  assert.ok(a.some((e) => e.action === 'admin.ediscovery.export'));
  const rep = (await boss('/org/reports')).data;
  assert.ok(rep.sent7d > 0 && rep.received7d > 0);
  assert.ok(rep.users.some((u) => u.email === 'ann@acme.test'));
});

test('import mail from .mbox and from another IMAP account', async () => {
  const mbox = 'From a@x.test Mon Jan  1 00:00:00 2024\nFrom: Old Friend <a@x.test>\nTo: ann@acme.test\nSubject: Old one\nMessage-ID: <old1@x.test>\n\nHello from 2024\n>From the archive\n\nFrom b@x.test Tue Jan  2 00:00:00 2024\nFrom: b@x.test\nSubject: Old two\nMessage-ID: <old2@x.test>\n\nSecond\n';
  const r = await ann('/me/import/file', { filename: 'takeout.mbox', contentBase64: Buffer.from(mbox).toString('base64') });
  assert.deepEqual(r.data, { imported: 2, skipped: 0 });
  const again = await ann('/me/import/file', { filename: 'takeout.mbox', contentBase64: Buffer.from(mbox).toString('base64') });
  assert.deepEqual(again.data, { imported: 0, skipped: 2 }, 'duplicates skipped');
  const arch = (await ann(`/messages?folder=${(await folder(ann, 'archive')).id}`)).data.messages;
  assert.ok(arch.some((m) => m.subject === 'Old one'));

  // Copy Raj's mailbox (over IMAP) into a fresh account
  const legal = await login('legal@acme.test');
  const before = (await inbox(legal)).length;
  const job = await legal('/me/import/imap', { host: '127.0.0.1', port: imapPort, secure: false, username: 'raj@acme.test', password: 'password123' });
  assert.equal(job.status, 202, JSON.stringify(job.data));
  let j;
  for (let i = 0; i < 50; i++) {
    j = (await legal('/me/import')).data.jobs.find((x) => x.id === job.data.jobId);
    if (j.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(j.status, 'done', j.error);
  assert.ok(j.imported >= 3);
  const after = await inbox(legal);
  assert.ok(after.length > before && after.some((m) => m.subject === 'Team target'));
  const bad = await legal('/me/import/imap', { host: '127.0.0.1', port: imapPort, secure: false, username: 'raj@acme.test', password: 'wrong' });
  assert.equal(bad.status, 400);
});
