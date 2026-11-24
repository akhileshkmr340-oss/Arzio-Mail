// The Outlook-style ribbon: Ignore, Clean Up, Follow Up, Quick Steps, filters and
// sorting, contact groups, the address book, Save as file, forward as attachment, Insights.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-ribbon-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log', ARZIO_PUSH: 'off' });
const { app } = await import('../src/server.js');

let base;
const sessions = {};
const call = async (who, p, { body, method } = {}) => {
  const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(who ? { 'x-arzio-session': sessions[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), res };
};
const folders = async (who) => (await call(who, '/folders')).data.folders;
const inbox = async (who, extra = '') => {
  const id = (await folders(who)).find((f) => f.role === 'inbox').id;
  return (await call(who, `/messages?folder=${id}${extra}`)).data.messages;
};
const send = (who, body) => call(who, '/send', { body: { noSignature: true, ...body } });

before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.unref();
  for (const [u, n] of [['dev', 'Dev Rao'], ['eva', 'Eva Lim']]) {
    await call(null, '/auth/signup', { body: { username: u, name: n, password: 'password123' } });
    sessions[u] = (await call(null, '/auth/login', { body: { email: `${u}@arzio.test`, password: 'password123', client: 'app' } })).data.session;
    await call(u, '/me/preferences', { method: 'PATCH', body: { undo_send_seconds: 0 } });
  }
});

test('Ignore moves a conversation and its later replies to Deleted Items, and can be undone', async () => {
  await send('dev', { to: 'eva@arzio.test', subject: 'Noisy thread', text: 'First message in a noisy thread.' });
  const [m] = await inbox('eva');
  const r = await call('eva', `/messages/${m.id}/ignore`, { body: {} });
  assert.equal(r.data.moved, 1);
  const orig = (await call('dev', '/messages?folder=' + (await folders('dev')).find((f) => f.role === 'sent').id)).data.messages[0];
  const full = (await call('dev', `/messages/${orig.id}`)).data.message;
  await send('dev', { to: 'eva@arzio.test', subject: 'Re: Noisy thread', text: 'A later reply.', inReplyTo: full.message_id, references: full.message_id });
  assert.equal((await inbox('eva')).length, 0, 'the reply skipped the Inbox');
  const trash = (await folders('eva')).find((f) => f.role === 'trash');
  assert.equal(trash.total, 2);
  const undo = await call('eva', `/messages/${m.id}/ignore`, { body: { ignore: false } });
  assert.equal(undo.data.moved, 2);
  assert.equal((await inbox('eva')).length, 2);
});

test('Clean Up removes messages that a later reply fully quotes', async () => {
  const [newest] = await inbox('eva');
  const before_ = (await inbox('eva')).length;
  // the second message quotes nothing, so nothing is redundant yet
  assert.equal((await call('eva', `/messages/${newest.id}/cleanup`, { body: {} })).data.removed, 0);
  const sent = (await call('dev', '/messages?folder=' + (await folders('dev')).find((f) => f.role === 'sent').id)).data.messages.find((x) => x.subject === 'Noisy thread');
  const full = (await call('dev', `/messages/${sent.id}`)).data.message;
  await send('dev', { to: 'eva@arzio.test', subject: 'Re: Noisy thread', text: 'Quoting you.\n\n> First message in a noisy thread.', inReplyTo: full.message_id, references: full.message_id });
  const r = await call('eva', `/messages/${newest.id}/cleanup`, { body: {} });
  assert.equal(r.data.removed, 1, 'the quoted original moved to Deleted Items');
  assert.equal((await inbox('eva')).length, before_);
});

test('Follow Up sets a due date, completes and clears', async () => {
  const [m] = await inbox('eva');
  const due = new Date(Date.now() + 86400e3).toISOString();
  let r = await call('eva', `/messages/${m.id}/followup`, { body: { state: 'flagged', due_at: due } });
  assert.equal(r.data.message.is_flagged, true);
  assert.equal(r.data.message.flag_due_at, due);
  const listed = (await inbox('eva', '&filter=flagged'))[0];
  assert.equal(listed.flag_due_at, due, 'the list shows the due date');
  r = await call('eva', `/messages/${m.id}/followup`, { body: { state: 'complete' } });
  assert.equal(r.data.message.is_flagged, false);
  assert.ok(r.data.message.flag_completed_at);
  r = await call('eva', `/messages/${m.id}/followup`, { body: { state: 'clear' } });
  assert.equal(r.data.message.flag_completed_at, null);
  assert.equal((await call('eva', `/messages/${m.id}/followup`, { body: { state: 'flagged', due_at: 'soon' } })).status, 400);
});

test('Filter Email and Arrange By', async () => {
  await send('dev', { to: 'eva@arzio.test', subject: 'Urgent: budget', text: 'Please look', importance: 'high' });
  await send('dev', { to: 'eva@arzio.test', subject: 'Aardvark facts', text: 'Some facts', attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') }] });
  assert.deepEqual((await inbox('eva', '&filter=important')).map((m) => m.subject), ['Urgent: budget']);
  assert.deepEqual((await inbox('eva', '&filter=attachments')).map((m) => m.subject), ['Aardvark facts']);
  assert.ok((await inbox('eva', '&filter=tome')).length >= 3);
  assert.equal((await inbox('eva', '&filter=unread')).every((m) => !m.is_read), true);
  const bySubject = (await inbox('eva', '&sort=subject')).map((m) => m.subject);
  assert.equal(bySubject[0], 'Aardvark facts');
  const oldest = (await inbox('eva', '&sort=date-asc'))[0];
  assert.match(oldest.subject, /Noisy thread/);
});

test('Quick Steps have Outlook defaults and can be replaced or reset', async () => {
  let r = await call('eva', '/me/quick-steps');
  assert.deepEqual(r.data.steps.map((s) => s.name), ['Move to: ?', 'To Manager', 'Team Email', 'Done', 'Reply & Delete']);
  r = await call('eva', '/me/quick-steps', { method: 'PUT', body: { steps: [{ name: 'File receipts', icon: 'move', actions: [{ type: 'read' }, { type: 'move', value: '5' }, { type: 'explode' }] }] } });
  assert.deepEqual(r.data.steps, [{ name: 'File receipts', icon: 'move', actions: [{ type: 'read', value: null }, { type: 'move', value: '5' }] }]);
  assert.equal((await call('eva', '/me/quick-steps', { method: 'PUT', body: { steps: [{ name: 'Empty', actions: [] }] } })).status, 400);
  r = await call('eva', '/me/quick-steps', { method: 'PUT', body: { reset: true } });
  assert.equal(r.data.steps.length, 5);
  assert.equal((await call('eva', '/me/quick-steps')).data.steps[0].name, 'Move to: ?');
});

test('contact groups appear in Browse Groups and the Address Book', async () => {
  await call('eva', '/contacts', { body: { email: 'dev@arzio.test', name: 'Dev Rao', company: 'Arzio' } });
  const bad = await call('eva', '/contact-lists', { body: { name: 'Team', members: ['not-an-email'] } });
  assert.equal(bad.status, 400);
  const g = (await call('eva', '/contact-lists', { body: { name: 'Launch team', members: ['Dev Rao <dev@arzio.test>', { email: 'x@example.com', name: 'X' }, 'x@example.com'].map((m) => (typeof m === 'string' && m.includes('<') ? { email: 'dev@arzio.test', name: 'Dev Rao' } : m)) } })).data.list;
  assert.equal(g.members.length, 2, 'duplicates are dropped');
  const dir_ = (await call('eva', '/groups/directory')).data;
  assert.equal(dir_.lists[0].name, 'Launch team');
  const ab = (await call('eva', '/address-book?q=dev')).data;
  assert.equal(ab.contacts[0].email, 'dev@arzio.test');
  assert.equal((await call('eva', '/address-book?q=launch')).data.lists[0].members.length, 2);
  assert.equal((await call('dev', `/contact-lists/${g.id}`, { method: 'DELETE' })).status, 404, 'others cannot delete it');
  assert.equal((await call('eva', `/contact-lists/${g.id}`, { method: 'DELETE' })).status, 200);
});

test('Save as File returns the message, and Forward as Attachment carries it', async () => {
  const [m] = await inbox('eva', '&filter=important');
  const eml = await call('eva', `/messages/${m.id}/eml`);
  assert.equal(eml.status, 200);
  assert.match(eml.res.headers.get('content-disposition'), /Urgent.*budget\.eml/);
  assert.match(eml.data, /Subject: Urgent: budget/);
  assert.equal((await call('dev', `/messages/${m.id}/eml`)).status, 404);
  const r = await send('eva', { to: 'dev@arzio.test', subject: 'Fw: Urgent: budget', text: 'See attached', attachMessages: [m.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const got = (await inbox('dev')).find((x) => x.subject === 'Fw: Urgent: budget');
  const full = (await call('dev', `/messages/${got.id}?links=1`)).data.message;
  assert.ok(full.attachments.some((a) => /\.eml$/.test(a.filename)), JSON.stringify(full.attachments));
});

test('Insights summarizes the week', async () => {
  const r = await call('eva', '/insights');
  assert.ok(r.data.week.received >= 4);
  assert.equal(r.data.week.sent, 1);
  assert.equal(r.data.topSenders[0].email, 'dev@arzio.test');
  assert.equal(typeof r.data.meetings.hours, 'number');
});

test('ribbon layout preferences are saved', async () => {
  const r = await call('eva', '/me/ui', { method: 'PATCH', body: { ribbon: 'simplified', sort: 'from', folderPane: false } });
  assert.equal(r.data.ui.ribbon, 'simplified');
  assert.equal(r.data.ui.sort, 'from');
  assert.equal(r.data.ui.folderPane, false);
});
