// Phase 3: calendar and meeting invites, To Do, reminders, IMAP and SMTP for
// mail apps, app passwords, API tokens, meeting prep.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-p3-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log', IMAP_PORT: '0', SUBMISSION_PORT: '0' });
const { app } = await import('../src/server.js');
const { processReminders } = await import('../src/calendar/service.js');
const { startImap } = await import('../src/mail/imap.js');
const { startSubmission } = await import('../src/mail/smtp-submission.js');
const { ImapFlow } = await import('imapflow');
const nodemailer = (await import('nodemailer')).default;

let base;
let alice; let bob;
let imapPort; let smtpPort;
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
  bob = await signup('bob');
});

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
async function signup(name) {
  const c = client();
  const r = await c('/auth/signup', { username: name, name: name[0].toUpperCase() + name.slice(1), password: 'password123' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await c('/me/preferences', { undo_send_seconds: 0 }, 'PATCH');
  return c;
}
const folder = async (c, role) => (await c('/folders')).data.folders.find((f) => f.role === role);
const inboxMsgs = async (c) => (await c(`/messages?folder=${(await folder(c, 'inbox')).id}&limit=100`)).data.messages;
const range = '?from=2030-01-01T00:00:00Z&to=2030-03-01T00:00:00Z';

test('meeting invites: invite, accept, update and cancel across mailboxes', async () => {
  const ev = (await alice('/calendar/events', { title: 'Budget review', start_at: '2030-01-10T10:00:00Z', end_at: '2030-01-10T11:00:00Z', location: 'Room 4', attendees: ['bob@arzio.test'] })).data.event;
  assert.equal(ev.my_status, 'organizer');

  const invite = (await inboxMsgs(bob)).find((m) => m.subject === 'Invitation: Budget review');
  assert.ok(invite, 'bob got the invitation');
  const full = (await bob(`/messages/${invite.id}`)).data.message;
  assert.equal(full.calendar.method, 'REQUEST');
  let bobEv = (await bob(`/calendar/events${range}`)).data.events[0];
  assert.equal(bobEv.title, 'Budget review');
  assert.equal(bobEv.my_status, 'needs-action');

  const r = await bob(`/calendar/events/${full.calendar.eventId}/respond`, { status: 'accepted' });
  assert.equal(r.status, 200);
  const aliceEv = (await alice(`/calendar/events/${ev.id}`)).data.event;
  assert.equal(aliceEv.attendees[0].status, 'accepted');
  assert.ok((await inboxMsgs(alice)).some((m) => m.subject === 'Accepted: Budget review'));

  await alice(`/calendar/events/${ev.id}`, { start_at: '2030-01-11T10:00:00Z', end_at: '2030-01-11T11:00:00Z' }, 'PUT');
  bobEv = (await bob(`/calendar/events${range}`)).data.events[0];
  assert.equal(bobEv.start_at, '2030-01-11T10:00:00.000Z');
  assert.equal(bobEv.my_status, 'needs-action', 'a new time needs a new answer');

  await alice(`/calendar/events/${ev.id}`, null, 'DELETE');
  assert.equal((await bob(`/calendar/events${range}`)).data.events.length, 0, 'cancelled for bob');
});

test('recurring events expand, feed and import work', async () => {
  await alice('/calendar/events', { title: 'Standup', start_at: '2030-02-02T09:00:00Z', end_at: '2030-02-02T09:15:00Z', recurrence: 'daily', recur_until: '2030-02-06T23:00:00Z' });
  const list = (await alice('/calendar/events?from=2030-02-01T00:00:00Z&to=2030-02-10T00:00:00Z')).data.events.filter((e) => e.title === 'Standup');
  assert.equal(list.length, 5);

  const feed = (await alice('/calendar/feed', {})).data.url;
  const ics = await (await fetch(feed.replace(/^https?:\/\/[^/]+\/api/, base))).text();
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /RRULE:FREQ=DAILY/);

  const imported = await bob('/calendar/import', { ics: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x1@test\r\nSUMMARY:Dentist\r\nDTSTART;TZID=Asia/Kolkata:20300120T100000\r\nDURATION:PT30M\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' });
  assert.equal(imported.data.imported, 1);
  const dent = (await bob(`/calendar/events${range}`)).data.events.find((e) => e.title === 'Dentist');
  assert.equal(dent.start_at, '2030-01-20T04:30:00.000Z', 'time zone converted');
  assert.equal(dent.end_at, '2030-01-20T05:00:00.000Z');
});

test('To Do tasks, flagged mail and reminders', async () => {
  const t = (await bob('/tasks', { title: 'File taxes', due_at: '2030-04-15T00:00:00Z', reminder_at: new Date(Date.now() - 1000).toISOString(), important: true })).data.task;
  assert.equal(t.important, true);
  await bob(`/tasks/${t.id}`, { completed: true }, 'PATCH');
  let tasks = (await bob('/tasks')).data;
  assert.equal(tasks.tasks[0].completed, true);
  const t2 = (await bob('/tasks', { title: 'Call bank', reminder_at: new Date(Date.now() - 1000).toISOString() })).data.task;
  const soon = new Date(Date.now() + 5 * 60e3).toISOString();
  await bob('/calendar/events', { title: 'Quick sync', start_at: soon, end_at: new Date(Date.now() + 35 * 60e3).toISOString(), reminder_minutes: 15 });
  processReminders();
  processReminders();
  const n = (await bob('/notifications?unread=1')).data.notifications;
  assert.deepEqual(n.map((x) => x.title).sort(), ['Call bank', 'Quick sync']);
  await bob('/notifications/read', {});
  assert.equal((await bob('/notifications?unread=1')).data.notifications.length, 0);
  await bob(`/tasks/${t2.id}`, null, 'DELETE');
  const msg = (await inboxMsgs(bob))[0];
  await bob(`/messages/${msg.id}`, { is_flagged: true }, 'PATCH');
  tasks = (await bob('/tasks')).data;
  assert.equal(tasks.flagged.length, 1);
});

test('IMAP and SMTP submission with an app password', async () => {
  // MFA users need app passwords; plain account password also works when MFA is off
  const ap = (await alice('/me/app-passwords', { name: 'Thunderbird' })).data;
  assert.match(ap.password, /^[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}$/);

  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user: 'alice@arzio.test', pass: ap.password } });
  await transport.sendMail({ from: 'alice@arzio.test', to: 'bob@arzio.test', subject: 'Sent from Thunderbird', text: 'Hello over SMTP' });
  assert.ok((await inboxMsgs(bob)).some((m) => m.subject === 'Sent from Thunderbird'));
  await assert.rejects(transport.sendMail({ from: 'ceo@bank.example', to: 'bob@arzio.test', subject: 'x', text: 'x' }), /only send as/);
  const bad = nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user: 'alice@arzio.test', pass: 'wrong' } });
  await assert.rejects(bad.sendMail({ from: 'alice@arzio.test', to: 'bob@arzio.test', subject: 'x', text: 'x' }), /Authentication failed/);

  const imap = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: { user: 'bob@arzio.test', pass: 'password123' }, logger: false });
  await imap.connect();
  const boxes = await imap.list();
  const sent = boxes.find((b) => b.specialUse === '\\Sent');
  assert.equal(sent.path, 'Sent Items');
  assert.ok(boxes.some((b) => b.path === 'INBOX'));
  const status = await imap.status('INBOX', { messages: true, unseen: true });
  assert.ok(status.messages >= 2);

  const lock = await imap.getMailboxLock('INBOX');
  try {
    const found = await imap.search({ subject: 'Thunderbird' }, { uid: true });
    assert.equal(found.length, 1);
    const msg = await imap.fetchOne(String(found[0]), { envelope: true, source: true, flags: true, bodyStructure: true, size: true }, { uid: true });
    assert.equal(msg.envelope.subject, 'Sent from Thunderbird');
    assert.equal(msg.envelope.from[0].address, 'alice@arzio.test');
    assert.match(msg.source.toString(), /Hello over SMTP/);
    assert.equal(msg.size, msg.source.length);
    assert.equal(msg.bodyStructure.type, 'text/plain');
    // partial body section
    const part = await imap.download(String(found[0]), '1', { uid: true });
    let body = '';
    for await (const ch of part.content) body += ch;
    assert.match(body, /Hello over SMTP/);

    await imap.messageFlagsAdd(String(found[0]), ['\\Flagged', '\\Seen'], { uid: true });
    const web = (await inboxMsgs(bob)).find((m) => m.subject === 'Sent from Thunderbird');
    assert.equal(web.is_flagged, true);
    assert.equal(web.is_read, true);

    // The invite message has a multipart structure
    const inv = await imap.search({ subject: 'Invitation' }, { uid: true });
    const invMsg = await imap.fetchOne(String(inv[0]), { bodyStructure: true }, { uid: true });
    assert.match(invMsg.bodyStructure.type, /^multipart\//);

    const moved = await imap.messageMove(String(found[0]), 'Archive', { uid: true });
    assert.ok(moved.uidMap.size === 1);
  } finally {
    lock.release();
  }
  const archived = (await bob(`/messages?folder=${(await folder(bob, 'archive')).id}`)).data.messages;
  assert.ok(archived.some((m) => m.subject === 'Sent from Thunderbird'), 'move shows in web app');

  // APPEND (mail apps save drafts and sent copies this way)
  const res = await imap.append('Drafts', 'From: bob@arzio.test\r\nTo: alice@arzio.test\r\nSubject: Draft from app\r\n\r\nWork in progress\r\n', ['\\Draft']);
  assert.ok(res.uid > 0);
  const drafts = (await bob(`/messages?folder=${(await folder(bob, 'drafts')).id}`)).data.messages;
  assert.ok(drafts.some((m) => m.subject === 'Draft from app'));

  // Delete + expunge
  const lock2 = await imap.getMailboxLock('Drafts');
  try {
    await imap.messageDelete(String(res.uid), { uid: true });
  } finally {
    lock2.release();
  }
  assert.ok(!(await bob(`/messages?folder=${(await folder(bob, 'drafts')).id}`)).data.messages.some((m) => m.subject === 'Draft from app'));

  // Folders
  await imap.mailboxCreate('Projects/Arzio');
  assert.ok((await bob('/folders')).data.folders.some((f) => f.name === 'Projects/Arzio'));
  await imap.logout();

  const wrong = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: { user: 'bob@arzio.test', pass: 'nope' }, logger: false });
  await assert.rejects(wrong.connect());
  wrong.close();
});

test('API tokens: read-only by default, send scope allows sending', async () => {
  const ro = (await alice('/me/tokens', { name: 'Reader' })).data;
  assert.match(ro.token, /^arz_/);
  const call = (tok, p, body) => fetch(base + p, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call(ro.token, '/folders')).status, 200);
  assert.equal((await call(ro.token, '/send', { to: 'bob@arzio.test', subject: 'x', text: 'x' })).status, 403);
  const rw = (await alice('/me/tokens', { name: 'Agent', scopes: 'read,send' })).data;
  assert.equal((await call(rw.token, '/send', { to: 'bob@arzio.test', subject: 'From an agent', text: 'hi' })).status, 200);
  assert.equal((await call(rw.token, '/me/tokens', { name: 'escalate' })).status, 403);
  assert.equal((await call('arz_notarealtokennotarealtoken', '/folders')).status, 401);
});

test('meeting prep brief finds related mail', async () => {
  await bob('/send', { to: 'alice@arzio.test', subject: 'Roadmap planning notes', text: 'Here are my notes for roadmap planning.' });
  const ev = (await alice('/calendar/events', { title: 'Roadmap planning', start_at: '2030-01-15T10:00:00Z', end_at: '2030-01-15T11:00:00Z', attendees: ['bob@arzio.test'] })).data.event;
  const b = (await alice(`/calendar/events/${ev.id}/brief`, {})).data;
  assert.ok(b.brief);
  assert.ok(b.sources.some((s) => s.subject === 'Roadmap planning notes'));
});

test('MCP server: AI agents search mail and act with a token', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const tok = (await bob('/me/tokens', { name: 'Claude', scopes: 'read,send' })).data.token;
  const url = new URL(base.replace(/\/api$/, '/mcp'));
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${tok}` } } }));
  const tools = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes('search_mail') && tools.includes('send_mail') && tools.includes('create_event'));
  const found = JSON.parse((await c.callTool({ name: 'search_mail', arguments: { query: 'roadmap' } })).content[0].text);
  assert.ok(found.length >= 1);
  const msg = JSON.parse((await c.callTool({ name: 'read_message', arguments: { id: found[0].id } })).content[0].text);
  assert.match(msg.subject, /Roadmap/);
  const task = JSON.parse((await c.callTool({ name: 'create_task', arguments: { title: 'Reply about roadmap', messageId: found[0].id } })).content[0].text);
  assert.ok(task.id);
  await c.close();

  const ro = (await bob('/me/tokens', { name: 'Reader' })).data.token;
  const c2 = new Client({ name: 'test', version: '1.0.0' });
  await c2.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${ro}` } } }));
  assert.ok(!(await c2.listTools()).tools.some((t) => t.name === 'send_mail'), 'read-only token has no send tool');
  await c2.close();
  const noAuth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(noAuth.status, 401);
});
