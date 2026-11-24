// Outlook-on-the-web parity: rich text with inline pictures, @mentions,
// importance, read receipts, reactions, appearance settings and shared calendars.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-owa-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log', ARZIO_PUSH: 'off' });
const { app } = await import('../src/server.js');
const { cleanHtml, inlineImages } = await import('../src/mail/html.js');

let base;
const sessions = {};
const call = async (who, p, { body, method } = {}) => {
  const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(who ? { 'x-arzio-session': sessions[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})), res };
};
const inbox = async (who, extra = '') => {
  const { data } = await call(who, '/folders');
  const id = data.folders.find((f) => f.role === 'inbox').id;
  return (await call(who, `/messages?folder=${id}${extra}`)).data.messages;
};
// 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.unref();
  for (const [u, n] of [['asha', 'Asha Rao'], ['ben', 'Ben Cole'], ['chen', 'Chen Li']]) {
    await call(null, '/auth/signup', { body: { username: u, name: n, password: 'password123' } });
    sessions[u] = (await call(null, '/auth/login', { body: { email: `${u}@arzio.test`, password: 'password123', client: 'app' } })).data.session;
    await call(u, '/me/preferences', { method: 'PATCH', body: { undo_send_seconds: 0 } });
  }
});

test('composed HTML is cleaned and pasted pictures go out as inline attachments', async () => {
  const dirty = '<p onclick="x()">Hi <b>there</b></p><script>alert(1)</script><a href="javascript:alert(1)">x</a><iframe src="https://e.vil"></iframe><img src="x" onerror="steal()">';
  const clean = cleanHtml(dirty);
  assert.ok(!/script|onclick|onerror|javascript:|iframe/i.test(clean), clean);
  assert.ok(clean.includes('<b>there</b>'));
  const inl = inlineImages(`<p>Chart:</p><img src="data:image/png;base64,${PNG}">`, 'arzio.test');
  assert.equal(inl.attachments.length, 1);
  assert.match(inl.html, /src="cid:[^"]+@arzio\.test"/);

  await call('asha', '/me', { method: 'PATCH', body: { signature: 'Asha | Arzio' } });
  const sent = await call('asha', '/send', { body: {
    to: 'ben@arzio.test', subject: 'Rich text', text: 'Hello Ben',
    html: `<div class="arzio-body"><p>Hello <b>Ben</b> <span style="color:#c50f1f">red</span></p><img src="data:image/png;base64,${PNG}"><script>x</script></div>`,
    noSignature: true, importance: 'high', readReceipt: true,
  } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const [m] = await inbox('ben');
  assert.equal(m.subject, 'Rich text');
  assert.equal(m.importance, 'high', 'importance travels with the message');
  const app = (await call('ben', `/messages/${m.id}`)).data.message;
  assert.match(app.html_body, /src="data:image\/png;base64,/, 'the phone app gets pictures embedded');
  const full = (await call('ben', `/messages/${m.id}?links=1`)).data.message;
  assert.ok(full.html_body.includes('<b>Ben</b>'));
  assert.ok(!full.html_body.includes('<script'));
  assert.match(full.html_body, /src="\/api\/attachments\/\d+\?inline=1"/, 'inline picture points at the attachment');
  assert.equal(full.attachments.length, 1);
  assert.equal(full.attachments[0].inline, true, 'inline pictures are not listed as files');
  assert.equal(full.receipt_to, 'asha@arzio.test', 'read receipt requested');
  // the inline picture is served inline, other files as downloads
  const img = await fetch(base + `/attachments/${full.attachments[0].id}?inline=1`, { headers: { 'x-arzio-session': sessions.ben } });
  assert.match(img.headers.get('content-disposition'), /^inline/);
  // signature is not added twice when the composer already placed it
  assert.ok(!full.text_body.includes('Asha | Arzio'));
});

test('read receipts are sent only when the reader agrees, once', async () => {
  const [m] = await inbox('ben');
  const r = await call('ben', `/messages/${m.id}/receipt`, { body: { send: true } });
  assert.equal(r.data.sent, true);
  const got = await inbox('asha');
  assert.ok(got.some((x) => x.subject === 'Read: Rich text'), 'sender gets the receipt');
  const again = await call('ben', `/messages/${m.id}/receipt`, { body: { send: true } });
  assert.equal(again.data.sent, false, 'only once');
  assert.equal((await call('ben', `/messages/${m.id}`)).data.message.receipt_to, null);
});

test('@mentions mark the message for the person mentioned', async () => {
  await call('asha', '/send', { body: {
    to: 'ben@arzio.test, chen@arzio.test', subject: 'Launch plan', text: '@Chen can you check the numbers?',
    html: '<div><a href="mailto:chen@arzio.test" data-mention="chen@arzio.test" class="mention">@Chen</a> can you check the numbers?</div>', noSignature: true,
  } });
  const chen = await inbox('chen', '&mentions=1');
  assert.equal(chen.length, 1);
  assert.equal(chen[0].mentions_me, true);
  const ben = await inbox('ben', '&mentions=1');
  assert.equal(ben.length, 0, 'Ben was not mentioned');
});

test('reactions are shared across every copy of a message, one per person', async () => {
  const benMsg = (await inbox('ben')).find((m) => m.subject === 'Launch plan');
  const chenMsg = (await inbox('chen')).find((m) => m.subject === 'Launch plan');
  let r = await call('ben', `/messages/${benMsg.id}/reactions`, { body: { emoji: '👍' } });
  assert.deepEqual(r.data.reactions.map((x) => [x.emoji, x.count, x.mine]), [['👍', 1, true]]);
  r = await call('chen', `/messages/${chenMsg.id}/reactions`, { body: { emoji: '👍' } });
  assert.equal(r.data.reactions[0].count, 2);
  r = await call('chen', `/messages/${chenMsg.id}/reactions`, { body: { emoji: '🎉' } });
  assert.deepEqual(r.data.reactions.map((x) => [x.emoji, x.count]).sort(), [['🎉', 1], ['👍', 1]], 'changing a reaction replaces it');
  const look = await call('ben', '/reactions/lookup', { body: { ids: [benMsg.id] } });
  assert.equal(look.data.reactions[benMsg.id].length, 2);
  r = await call('chen', `/messages/${chenMsg.id}/reactions`, { body: { emoji: '🎉' } });
  assert.equal(r.data.reactions.length, 1, 'the same reaction again removes it');
  assert.equal((await call('ben', `/messages/${benMsg.id}/reactions`, { body: { emoji: '💩' } })).status, 400);
  // others cannot react to mail they do not have
  assert.equal((await call('asha', `/messages/${benMsg.id}/reactions`, { body: { emoji: '👍' } })).status, 404);
});

test('appearance settings are kept per user and validated', async () => {
  const r = await call('ben', '/me/ui', { method: 'PATCH', body: { theme: 'dark', density: 'compact', readingPane: 'bottom', accent: 'teal', shortcuts: 'gmail', conversations: false, favorites: ['folder:1', 'smart:flagged', 'bogus'], theme2: 'x' } });
  assert.deepEqual(r.data.ui, { theme: 'dark', accent: 'teal', density: 'compact', readingPane: 'bottom', shortcuts: 'gmail', conversations: false, favorites: ['folder:1', 'smart:flagged'] });
  await call('ben', '/me/ui', { method: 'PATCH', body: { theme: 'neon' } });
  const me = (await call('ben', '/me')).data.user;
  assert.equal(JSON.parse(me.ui_json).theme, 'dark', 'invalid values are ignored');
});

test('shared calendars: free/busy, view and edit permissions', async () => {
  const start = new Date(Date.now() + 86400e3); start.setUTCHours(9, 0, 0, 0);
  const ev = (await call('asha', '/calendar/events', { body: { title: 'Board review', location: 'Room 1', start_at: start.toISOString(), end_at: new Date(start.getTime() + 3600e3).toISOString() } })).data.event;
  const from = new Date(Date.now() - 86400e3).toISOString();
  const to = new Date(Date.now() + 7 * 86400e3).toISOString();
  const ownerId = (await call('asha', '/me')).data.user.id;

  assert.equal((await call('ben', `/calendar/shared/${ownerId}/events?from=${from}&to=${to}`)).status, 403, 'not shared yet');
  assert.equal((await call('asha', '/calendar/shares', { body: { email: 'nobody@arzio.test', role: 'view' } })).status, 404);

  await call('asha', '/calendar/shares', { body: { email: 'ben@arzio.test', role: 'freebusy' } });
  let r = await call('ben', `/calendar/shared/${ownerId}/events?from=${from}&to=${to}`);
  assert.equal(r.data.role, 'freebusy');
  assert.equal(r.data.events[0].title, 'Busy');
  assert.equal(r.data.events[0].location, undefined, 'no details with free/busy');
  assert.ok((await inbox('ben')).some((m) => /shared their calendar/.test(m.subject)), 'Ben is told by email');

  await call('asha', '/calendar/shares', { body: { email: 'ben@arzio.test', role: 'view' } });
  r = await call('ben', `/calendar/shared/${ownerId}/events?from=${from}&to=${to}`);
  assert.equal(r.data.events[0].title, 'Board review');
  assert.equal((await call('ben', `/calendar/shared/${ownerId}/events/${ev.id}`, { method: 'PUT', body: { title: 'Hacked' } })).status, 403, 'view cannot edit');

  await call('asha', '/calendar/shares', { body: { email: 'ben@arzio.test', role: 'edit' } });
  const upd = await call('ben', `/calendar/shared/${ownerId}/events/${ev.id}`, { method: 'PUT', body: { title: 'Board review (moved)' } });
  assert.equal(upd.status, 200);
  const created = await call('ben', `/calendar/shared/${ownerId}/events`, { body: { title: 'Prep', start_at: start.toISOString(), end_at: new Date(start.getTime() + 1800e3).toISOString() } });
  assert.equal(created.status, 201);
  const mine = (await call('asha', `/calendar/events?from=${from}&to=${to}`)).data.events.map((e) => e.title).sort();
  assert.deepEqual(mine, ['Board review (moved)', 'Prep']);

  const shares = (await call('ben', '/calendar/shares')).data;
  assert.equal(shares.received[0].role, 'edit');
  await call('ben', `/calendar/shares/${shares.received[0].id}`, { method: 'DELETE' });
  assert.equal((await call('ben', `/calendar/shared/${ownerId}/events?from=${from}&to=${to}`)).status, 403, 'removed');
});

test('translation explains what it needs when no AI provider is set', async () => {
  const [m] = await inbox('ben');
  const r = await call('ben', '/ai/translate', { body: { messageId: m.id, to: 'Hindi' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /ANTHROPIC_API_KEY/);
});
