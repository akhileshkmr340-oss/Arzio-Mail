// Exchange ActiveSync: this test plays the part of a phone (protocol 14.1)
// and walks through what the iPhone and Android mail apps do.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-eas-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log', ARZIO_EAS_POLL_MS: '200' });
const { app } = await import('../src/server.js');
const { E, encode, decode, child, kids, textOf } = await import('../src/eas/wbxml.js');

let root;
const basic = (u, pw = 'password123') => 'Basic ' + Buffer.from(`${u}:${pw}`).toString('base64');
function webClient() {
  let cookie = '';
  return async (p, body, method) => {
    const res = await fetch(root + '/api' + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}
let kai; let lin;

/** A phone: keeps its policy key, talks WBXML */
function phone(user, deviceId, { version = '14.1' } = {}) {
  const p = { policyKey: null };
  p.cmd = async (cmd, tree, { query = '', raw, headers = {} } = {}) => {
    const res = await fetch(`${root}/Microsoft-Server-ActiveSync?Cmd=${cmd}&User=${user}&DeviceId=${deviceId}&DeviceType=iPhone${query}`, {
      method: 'POST',
      headers: { authorization: basic(user), 'ms-asprotocolversion': version, 'content-type': raw ? 'message/rfc822' : 'application/vnd.ms-sync.wbxml', 'user-agent': 'Apple-iPhone/1', ...(p.policyKey ? { 'x-ms-policykey': p.policyKey } : {}), ...headers },
      body: raw || (tree ? encode(tree) : undefined),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf, body: /wbxml/.test(res.headers.get('content-type') || '') && buf.length ? decode(buf) : null };
  };
  p.provision = async () => {
    const r1 = await p.cmd('Provision', E('Provision:Provision', [
      E('Settings:DeviceInformation', [E('Settings:Set', [E('Settings:Model', 'iPhone16,2'), E('Settings:FriendlyName', "Kai's iPhone"), E('Settings:OS', 'iOS 19.1')])]),
      E('Provision:Policies', [E('Provision:Policy', [E('Provision:PolicyType', 'MS-EAS-Provisioning-WBXML')])])]));
    const pol = child(child(r1.body, 'Provision:Policies'), 'Provision:Policy');
    const temp = textOf(pol, 'Provision:PolicyKey');
    const r2 = await p.cmd('Provision', E('Provision:Provision', [E('Provision:Policies', [E('Provision:Policy', [
      E('Provision:PolicyType', 'MS-EAS-Provisioning-WBXML'), E('Provision:PolicyKey', temp), E('Provision:Status', 1)])])]));
    p.policyKey = textOf(child(child(r2.body, 'Provision:Policies'), 'Provision:Policy'), 'Provision:PolicyKey');
    return { r1, r2, temp };
  };
  p.folderSync = async (key = '0') => {
    const r = await p.cmd('FolderSync', E('FolderHierarchy:FolderSync', [E('FolderHierarchy:SyncKey', key)]));
    const ch = child(r.body, 'FolderHierarchy:Changes');
    return { r, key: textOf(r.body, 'FolderHierarchy:SyncKey'), status: textOf(r.body, 'FolderHierarchy:Status'),
      adds: kids(ch, 'FolderHierarchy:Add').map((a) => ({ id: textOf(a, 'FolderHierarchy:ServerId'), name: textOf(a, 'FolderHierarchy:DisplayName'), type: textOf(a, 'FolderHierarchy:Type') })),
      updates: kids(ch, 'FolderHierarchy:Update').map((a) => textOf(a, 'FolderHierarchy:DisplayName')), deletes: kids(ch, 'FolderHierarchy:Delete').map((a) => textOf(a, 'FolderHierarchy:ServerId')) };
  };
  p.keys = {};
  p.sync = async (coll, { commands, options, window, key, getChanges = true } = {}) => {
    const r = await p.cmd('Sync', E('AirSync:Sync', [E('AirSync:Collections', [E('AirSync:Collection', [
      E('AirSync:SyncKey', key ?? p.keys[coll] ?? '0'), E('AirSync:CollectionId', coll), (p.keys[coll] ?? '0') !== '0' && getChanges ? E('AirSync:GetChanges', 1) : null,
      window ? E('AirSync:WindowSize', window) : null, options || null, commands ? E('AirSync:Commands', commands) : null])])]));
    if (!r.body) return { r, empty: true };
    const c = child(child(r.body, 'AirSync:Collections'), 'AirSync:Collection');
    p.keys[coll] = textOf(c, 'AirSync:SyncKey');
    const cmds = child(c, 'AirSync:Commands');
    return {
      r, c, status: textOf(c, 'AirSync:Status'), key: p.keys[coll], more: !!child(c, 'AirSync:MoreAvailable'),
      adds: kids(cmds, 'AirSync:Add'), changes: kids(cmds, 'AirSync:Change'), deletes: kids(cmds, 'AirSync:Delete'),
      responses: child(c, 'AirSync:Responses'),
    };
  };
  return p;
}
const app_ = (n) => child(n, 'AirSync:ApplicationData');
const sidOf = (n) => textOf(n, 'AirSync:ServerId');

before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  root = `http://127.0.0.1:${server.address().port}`;
  server.unref();
  kai = webClient(); lin = webClient();
  assert.equal((await kai('/auth/signup', { username: 'kai', name: 'Kai Mehta', password: 'password123' })).status, 201);
  assert.equal((await lin('/auth/signup', { username: 'lin', name: 'Lin Park', password: 'password123' })).status, 201);
  await kai('/me/preferences', { undo_send_seconds: 0 }, 'PATCH');
  await lin('/me/preferences', { undo_send_seconds: 0 }, 'PATCH');
});

test('WBXML matches the byte layout in the protocol documents', () => {
  // FolderSync with SyncKey 0, as every phone sends first
  const bytes = encode(E('FolderHierarchy:FolderSync', [E('FolderHierarchy:SyncKey', '0')]));
  assert.equal(bytes.toString('hex'), '03016a00000756520330000101');
  const back = decode(bytes);
  assert.equal(back.tag, 'FolderHierarchy:FolderSync');
  assert.equal(textOf(back, 'FolderHierarchy:SyncKey'), '0');
  // Page switches, empty tags, opaque data and multi-byte lengths survive a round trip
  const big = Buffer.alloc(300, 7);
  const t = E('AirSync:Sync', [E('AirSync:Collections', [E('AirSync:Collection', [E('AirSync:SyncKey', 'é✓'), E('Email:Read', '1'), E('AirSync:MoreAvailable'), E('ComposeMail:Mime', big)])])]);
  const d = decode(encode(t));
  const c = child(child(d, 'AirSync:Collections'), 'AirSync:Collection');
  assert.equal(textOf(c, 'AirSync:SyncKey'), 'é✓');
  assert.equal(textOf(c, 'Email:Read'), '1');
  assert.ok(child(c, 'AirSync:MoreAvailable'));
  assert.ok(child(c, 'ComposeMail:Mime').opaque.equals(big));
});

test('discovery, sign-in and provisioning', async () => {
  const opt = await fetch(root + '/Microsoft-Server-ActiveSync', { method: 'OPTIONS', headers: { authorization: basic('kai@arzio.test') } });
  assert.equal(opt.status, 200);
  assert.match(opt.headers.get('ms-asprotocolversions'), /14\.1/);
  assert.match(opt.headers.get('ms-asprotocolcommands'), /Sync.*Ping/);

  const bad = await fetch(root + '/Microsoft-Server-ActiveSync?Cmd=FolderSync&User=kai&DeviceId=X1&DeviceType=iPhone', { method: 'POST', headers: { authorization: basic('kai', 'wrong') } });
  assert.equal(bad.status, 401);

  const ad = await fetch(root + '/autodiscover/autodiscover.xml', { method: 'POST', headers: { authorization: basic('kai@arzio.test'), 'content-type': 'text/xml' },
    body: '<?xml version="1.0"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/mobilesync/requestschema/2006"><Request><EMailAddress>kai@arzio.test</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006</AcceptableResponseSchema></Request></Autodiscover>' });
  assert.equal(ad.status, 200);
  assert.match(await ad.text(), /<Url>http[^<]+\/Microsoft-Server-ActiveSync<\/Url>/);

  const p = phone('kai@arzio.test', 'KAIPHONE1');
  // Before provisioning, commands are refused with "provisioning required"
  const pre = await p.cmd('FolderSync', E('FolderHierarchy:FolderSync', [E('FolderHierarchy:SyncKey', '0')]));
  assert.equal(textOf(pre.body, 'FolderHierarchy:Status'), '142');
  const { r1 } = await p.provision();
  assert.ok(child(child(child(child(r1.body, 'Provision:Policies'), 'Provision:Policy'), 'Provision:Data'), 'Provision:EASProvisionDoc'));
  assert.match(p.policyKey, /^\d+$/);
  const devs = (await kai('/me/devices')).data.devices;
  assert.equal(devs[0].model, 'iPhone16,2');
  assert.equal(devs[0].friendly_name, "Kai's iPhone");
});

test('folders, mail sync, read state both ways, push', async () => {
  const p = phone('kai@arzio.test', 'KAIPHONE2');
  await p.provision();
  const fs1 = await p.folderSync();
  assert.equal(fs1.status, '1');
  const byType = Object.fromEntries(fs1.adds.map((f) => [f.type, f]));
  assert.equal(byType[2].name, 'Inbox');
  assert.ok(byType[5] && byType[4] && byType[3], 'Sent, Deleted Items and Drafts');
  assert.equal(byType[8].id, 'cal');
  assert.equal(byType[9].id, 'con');
  assert.equal(byType[7].id, 'task');
  const inbox = byType[2].id;
  // Nothing changed: same key and no changes
  const again = await p.folderSync(fs1.key);
  assert.equal(again.key, fs1.key);
  assert.equal(again.adds.length, 0);

  // Lin sends Kai two messages, one with an attachment
  await lin('/send', { to: 'kai@arzio.test', subject: 'Lunch?', html: '<p>Are you free for <b>lunch</b> on Friday?</p>' });
  const pdf = Buffer.from('%PDF-1.4 ' + 'z'.repeat(2000));
  await lin('/send', { to: 'kai@arzio.test', subject: 'Contract', text: 'Please sign the attached contract. '.repeat(20), attachments: [{ filename: 'contract.pdf', contentType: 'application/pdf', contentBase64: pdf.toString('base64') }] });

  const first = await p.sync(inbox);
  assert.equal(first.key, '1');
  assert.equal(first.adds.length, 0, 'the first Sync only sets up the key');
  const options = E('AirSync:Options', [E('AirSync:FilterType', 0), E('AirSyncBase:BodyPreference', [E('AirSyncBase:Type', 2), E('AirSyncBase:TruncationSize', 200000)])]);
  const s = await p.sync(inbox, { options });
  assert.equal(s.status, '1');
  assert.equal(s.adds.length, 2);
  const lunch = s.adds.find((a) => textOf(app_(a), 'Email:Subject') === 'Lunch?');
  assert.match(textOf(app_(lunch), 'Email:From'), /lin@arzio\.test/);
  assert.equal(textOf(app_(lunch), 'Email:Read'), '0');
  const body = child(app_(lunch), 'AirSyncBase:Body');
  assert.equal(textOf(body, 'AirSyncBase:Type'), '2');
  assert.match(textOf(body, 'AirSyncBase:Data'), /<b>lunch<\/b>/);
  const contract = s.adds.find((a) => textOf(app_(a), 'Email:Subject') === 'Contract');
  const att = child(child(app_(contract), 'AirSyncBase:Attachments'), 'AirSyncBase:Attachment');
  assert.equal(textOf(att, 'AirSyncBase:DisplayName'), 'contract.pdf');

  // The attachment downloads through ItemOperations
  const io = await p.cmd('ItemOperations', E('ItemOperations:ItemOperations', [E('ItemOperations:Fetch', [E('ItemOperations:Store', 'Mailbox'), E('AirSyncBase:FileReference', textOf(att, 'AirSyncBase:FileReference'))])]));
  const fetched = child(child(io.body, 'ItemOperations:Response'), 'ItemOperations:Fetch');
  assert.equal(textOf(fetched, 'ItemOperations:Status'), '1');
  assert.ok(Buffer.from(textOf(child(fetched, 'ItemOperations:Properties'), 'ItemOperations:Data'), 'base64').equals(pdf));

  // Body preferences: a short plain-text preview, and the full MIME
  const p3 = phone('kai@arzio.test', 'KAIPHONE3');
  await p3.provision(); await p3.folderSync(); await p3.sync(inbox);
  const s3 = await p3.sync(inbox, { options: E('AirSync:Options', [E('AirSync:MIMESupport', 2), E('AirSyncBase:BodyPreference', [E('AirSyncBase:Type', 4), E('AirSyncBase:TruncationSize', 100000)])]) });
  const mime = textOf(child(app_(s3.adds.find((a) => textOf(app_(a), 'Email:Subject') === 'Contract')), 'AirSyncBase:Body'), 'AirSyncBase:Data');
  assert.match(mime, /Subject: Contract/);
  assert.match(mime, /contract\.pdf/);
  const p4 = phone('kai@arzio.test', 'KAIPHONE4');
  await p4.provision(); await p4.folderSync(); await p4.sync(inbox);
  const s4 = await p4.sync(inbox, { options: E('AirSync:Options', [E('AirSyncBase:BodyPreference', [E('AirSyncBase:Type', 1), E('AirSyncBase:TruncationSize', 40)])]) });
  const b4 = child(app_(s4.adds.find((a) => textOf(app_(a), 'Email:Subject') === 'Contract')), 'AirSyncBase:Body');
  assert.equal(textOf(b4, 'AirSyncBase:Truncated'), '1');
  assert.ok(Buffer.byteLength(textOf(b4, 'AirSyncBase:Data')) <= 40);

  // The phone marks "Lunch?" read and flags it: the web app sees it, and the phone gets no echo
  const lunchSid = sidOf(lunch);
  const ch = await p.sync(inbox, { commands: [E('AirSync:Change', [E('AirSync:ServerId', lunchSid), E('AirSync:ApplicationData', [E('Email:Read', 1), E('Email:Flag', [E('Email:FlagStatus', 2), E('Email:FlagType', 'Flag for follow up')])])])] });
  assert.equal(ch.changes.length, 0);
  const msgId = Number(lunchSid.split(':')[1]);
  const web = (await kai(`/messages/${msgId}`)).data.message;
  assert.equal(web.is_read, true);
  assert.equal(web.is_flagged, true);

  // Marked unread on the web: the phone gets a Change
  await kai(`/messages/${msgId}`, { is_read: false }, 'PATCH');
  const back = await p.sync(inbox);
  assert.equal(back.changes.length, 1);
  assert.equal(textOf(app_(back.changes[0]), 'Email:Read'), '0');

  // A lost response: the phone repeats the previous key and gets the same change again
  const prevKey = String(Number(back.key) - 1);
  const replay = await p.sync(inbox, { key: prevKey });
  assert.equal(replay.changes.length, 1);
  assert.equal(replay.key, back.key);

  // GetItemEstimate and push: Ping waits, new mail arrives, Ping answers "changes in Inbox"
  const est = await p.cmd('GetItemEstimate', E('GetItemEstimate:GetItemEstimate', [E('GetItemEstimate:Collections', [E('GetItemEstimate:Collection', [E('AirSync:SyncKey', p.keys[inbox]), E('GetItemEstimate:CollectionId', inbox)])])]));
  assert.equal(textOf(child(child(est.body, 'GetItemEstimate:Response'), 'GetItemEstimate:Collection'), 'GetItemEstimate:Estimate'), '0');
  const started = Date.now();
  const ping = p.cmd('Ping', E('Ping:Ping', [E('Ping:HeartbeatInterval', 120), E('Ping:Folders', [E('Ping:Folder', [E('Ping:Id', inbox), E('Ping:Class', 'Email')]), E('Ping:Folder', [E('Ping:Id', 'cal'), E('Ping:Class', 'Calendar')])])]));
  await new Promise((r) => setTimeout(r, 400));
  await lin('/send', { to: 'kai@arzio.test', subject: 'Pushed', text: 'This should arrive at once' });
  const pr = await ping;
  assert.equal(textOf(pr.body, 'Ping:Status'), '2');
  assert.deepEqual(kids(child(pr.body, 'Ping:Folders'), 'Ping:Folder').map((f) => f.text), [inbox]);
  assert.ok(Date.now() - started < 10000);
  const pushed = await p.sync(inbox);
  assert.equal(pushed.adds.length, 1);
  assert.equal(textOf(app_(pushed.adds[0]), 'Email:Subject'), 'Pushed');

  // Sync with Wait and nothing new: an empty answer after the wait
  const quiet = await p.cmd('Sync', E('AirSync:Sync', [E('AirSync:Collections', [E('AirSync:Collection', [E('AirSync:SyncKey', p.keys[inbox]), E('AirSync:CollectionId', inbox)])]), E('AirSync:HeartbeatInterval', 1)]));
  assert.equal(quiet.status, 200);
  assert.equal(quiet.buf.length, 0);

  // Move to Archive, then delete (goes to Deleted Items)
  const archive = fs1.adds.find((f) => f.name === 'Archive');
  const mv = await p.cmd('MoveItems', E('Move:MoveItems', [E('Move:Move', [E('Move:SrcMsgId', lunchSid), E('Move:SrcFldId', inbox), E('Move:DstFldId', archive.id)])]));
  const mvr = child(mv.body, 'Move:Response');
  assert.equal(textOf(mvr, 'Move:Status'), '3');
  assert.equal(textOf(mvr, 'Move:DstMsgId'), `${archive.id.slice(1)}:${msgId}`);
  assert.equal((await kai(`/messages/${msgId}`)).data.message.folder_id, Number(archive.id.slice(1)));
  const afterMove = await p.sync(inbox);
  assert.equal(afterMove.deletes.length, 0, 'the phone already knows it moved');
  const pushedSid = sidOf(pushed.adds[0]);
  await p.sync(inbox, { commands: [E('AirSync:Delete', [E('AirSync:ServerId', pushedSid)])] });
  const trash = fs1.adds.find((f) => f.type === '4');
  assert.equal((await kai(`/messages/${pushedSid.split(':')[1]}`)).data.message.folder_id, Number(trash.id.slice(1)));

  // Window size: MoreAvailable until everything is there
  for (const n of [1, 2]) await lin('/send', { to: 'kai@arzio.test', subject: `Batch ${n}`, text: 'x' });
  const p5 = phone('kai@arzio.test', 'KAIPHONE5');
  await p5.provision(); await p5.folderSync(); await p5.sync(inbox);
  const w1 = await p5.sync(inbox, { window: 1 });
  assert.equal(w1.adds.length, 1);
  assert.equal(w1.more, true);
  const seen = new Set([sidOf(w1.adds[0])]);
  let last = w1;
  while (last.more) { last = await p5.sync(inbox, { window: 1 }); for (const a of last.adds) seen.add(sidOf(a)); }
  const inboxCount = (await kai(`/messages?folder=${inbox.slice(1)}`)).data.messages.length;
  assert.equal(seen.size, inboxCount);
  assert.ok(seen.size >= 3);

  // A bad key asks the phone to start over
  const bad = await p.sync(inbox, { key: '999' });
  assert.equal(bad.status, '3');
});

test('sending, replying and forwarding from the phone', async () => {
  const p = phone('kai@arzio.test', 'KAIPHONE6');
  await p.provision();
  const mime = Buffer.from([
    'From: Kai Mehta <kai@arzio.test>', 'To: Lin Park <lin@arzio.test>', 'Bcc: secret@arzio.test', 'Subject: From my iPhone',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Sent from my phone ✓', ''].join('\r\n'));
  const r = await p.cmd('SendMail', E('ComposeMail:SendMail', [E('ComposeMail:ClientId', 'c1'), E('ComposeMail:SaveInSentItems'), E('ComposeMail:Mime', mime)]));
  assert.equal(r.status, 200);
  assert.equal(r.buf.length, 0, 'success has an empty body');
  const linInbox = (await lin('/folders')).data.folders.find((f) => f.role === 'inbox');
  const got = (await lin(`/messages?folder=${linInbox.id}`)).data.messages.find((m) => m.subject === 'From my iPhone');
  assert.ok(got, 'delivered');
  const full = (await lin(`/messages/${got.id}`)).data.message;
  assert.match(full.text_body, /Sent from my phone ✓/);
  assert.equal(full.bcc.length, 0, 'Bcc is not shown to recipients');
  const sent = (await kai('/folders')).data.folders.find((f) => f.role === 'sent');
  assert.ok((await kai(`/messages?folder=${sent.id}`)).data.messages.some((m) => m.subject === 'From my iPhone'), 'copy in Sent Items');

  // Sending as someone else is refused
  const spoof = await p.cmd('SendMail', E('ComposeMail:SendMail', [E('ComposeMail:ClientId', 'c2'), E('ComposeMail:Mime', Buffer.from('From: ceo@arzio.test\r\nTo: lin@arzio.test\r\nSubject: x\r\n\r\nx'))]));
  assert.equal(textOf(spoof.body, 'ComposeMail:Status'), '119');
  assert.ok(!(await lin(`/messages?folder=${linInbox.id}`)).data.messages.some((m) => m.from_addr === 'ceo@arzio.test'));

  // Lin writes back; Kai replies from the phone with SmartReply and the original is quoted
  await lin('/send', { to: 'kai@arzio.test', subject: 'Budget', text: 'The budget is 12 lakh.' });
  const kaiInbox = (await kai('/folders')).data.folders.find((f) => f.role === 'inbox');
  const orig = (await kai(`/messages?folder=${kaiInbox.id}`)).data.messages.find((m) => m.subject === 'Budget');
  const reply = Buffer.from('From: kai@arzio.test\r\nTo: lin@arzio.test\r\nSubject: Re: Budget\r\n\r\nAgreed.\r\n');
  const rr = await p.cmd('SmartReply', E('ComposeMail:SmartReply', [E('ComposeMail:ClientId', 'c3'), E('ComposeMail:SaveInSentItems'),
    E('ComposeMail:Source', [E('ComposeMail:FolderId', `f${kaiInbox.id}`), E('ComposeMail:ItemId', `${kaiInbox.id}:${orig.id}`)]), E('ComposeMail:Mime', reply)]));
  assert.equal(rr.status, 200);
  const re = (await lin(`/messages?folder=${linInbox.id}`)).data.messages.find((m) => m.subject === 'Re: Budget');
  const reFull = (await lin(`/messages/${re.id}`)).data.message;
  assert.match(reFull.text_body, /Agreed\./);
  assert.match(reFull.text_body, /> The budget is 12 lakh\./);
  const origFull = (await kai(`/messages/${orig.id}`)).data.message;
  assert.equal(reFull.in_reply_to, origFull.message_id, 'threaded as a reply');

  // 12.1 phones send raw MIME with the item in the query string
  const p12 = phone('kai@arzio.test', 'KAIPHONE12', { version: '12.1' });
  await p12.provision();
  const fw = await p12.cmd('SmartForward', null, { raw: Buffer.from('From: kai@arzio.test\r\nTo: lin@arzio.test\r\nSubject: Fwd: Budget\r\n\r\nFYI\r\n'), query: `&ItemId=${kaiInbox.id}:${orig.id}&CollectionId=f${kaiInbox.id}&SaveInSent=T` });
  assert.equal(fw.status, 200);
  const fwd = (await lin(`/messages?folder=${linInbox.id}`)).data.messages.find((m) => m.subject === 'Fwd: Budget');
  assert.match((await lin(`/messages/${fwd.id}`)).data.message.text_body, /Forwarded message[\s\S]*12 lakh/);
});

test('calendar, contacts and tasks both ways; meeting replies', async () => {
  const p = phone('kai@arzio.test', 'KAIPHONE7');
  await p.provision();
  await p.folderSync();
  for (const c of ['cal', 'con', 'task']) await p.sync(c);

  // From the phone: an event, a contact and a task
  const add = await p.sync('cal', { commands: [E('AirSync:Add', [E('AirSync:ClientId', 'ev1'), E('AirSync:ApplicationData', [
    E('Calendar:TimeZone', Buffer.alloc(172).toString('base64')), E('Calendar:Subject', 'Dentist'), E('Calendar:StartTime', '20261210T093000Z'), E('Calendar:EndTime', '20261210T103000Z'),
    E('Calendar:Location', 'Bandra'), E('Calendar:Reminder', 30), E('Calendar:BusyStatus', 2), E('Calendar:AllDayEvent', 0),
    E('AirSyncBase:Body', [E('AirSyncBase:Type', 1), E('AirSyncBase:Data', 'Bring the X-ray')])])])] });
  const addResp = child(add.responses, 'AirSync:Add');
  assert.equal(textOf(addResp, 'AirSync:Status'), '1');
  const evSid = textOf(addResp, 'AirSync:ServerId');
  assert.match(evSid, /^cal:\d+$/);
  assert.equal(add.adds.length, 0, 'no echo of the new event');
  const ev = (await kai('/calendar/events?from=2026-12-10T00:00:00Z&to=2026-12-11T00:00:00Z')).data.events.find((e) => e.title === 'Dentist');
  assert.equal(ev.location, 'Bandra');
  assert.equal(ev.reminder_minutes, 30);
  assert.equal(ev.description, 'Bring the X-ray');
  // The same Add again after a lost response is not duplicated
  const dup = await p.sync('cal', { key: String(Number(p.keys.cal) - 1), commands: [E('AirSync:Add', [E('AirSync:ClientId', 'ev1'), E('AirSync:ApplicationData', [E('Calendar:Subject', 'Dentist'), E('Calendar:StartTime', '20261210T093000Z'), E('Calendar:EndTime', '20261210T103000Z')])])] });
  assert.equal(textOf(child(dup.responses, 'AirSync:Add'), 'AirSync:ServerId'), evSid);
  assert.equal((await kai('/calendar/events?from=2026-12-10T00:00:00Z&to=2026-12-11T00:00:00Z')).data.events.filter((e) => e.title === 'Dentist').length, 1);

  // All-day event from a phone in India (UTC+5:30): stays on the right date
  const tz = Buffer.alloc(172); tz.writeInt32LE(-330, 0);
  await p.sync('cal', { commands: [E('AirSync:Add', [E('AirSync:ClientId', 'ev2'), E('AirSync:ApplicationData', [
    E('Calendar:TimeZone', tz.toString('base64')), E('Calendar:Subject', 'Diwali'), E('Calendar:AllDayEvent', 1),
    E('Calendar:StartTime', '20261207T183000Z'), E('Calendar:EndTime', '20261208T183000Z')])])] });
  const diwali = (await kai('/calendar/events?from=2026-12-07T00:00:00Z&to=2026-12-10T00:00:00Z')).data.events.find((e) => e.title === 'Diwali');
  assert.equal(diwali.all_day, true);
  assert.equal(diwali.start_at, '2026-12-08T00:00:00.000Z');

  // Edited on the web: the phone gets a Change with the new title and a weekly recurrence
  await kai(`/calendar/events/${ev.id}`, { title: 'Dentist (moved)', recurrence: 'weekly' }, 'PUT');
  const evCh = await p.sync('cal');
  const changed = evCh.changes.find((c) => sidOf(c) === evSid);
  assert.equal(textOf(app_(changed), 'Calendar:Subject'), 'Dentist (moved)');
  assert.equal(textOf(child(app_(changed), 'Calendar:Recurrence'), 'Calendar:Type'), '1');
  assert.equal(textOf(app_(changed), 'Calendar:StartTime'), '20261210T093000Z');

  // Deleted on the phone
  await p.sync('cal', { commands: [E('AirSync:Delete', [E('AirSync:ServerId', evSid)])] });
  assert.equal((await kai('/calendar/events?from=2026-12-10T00:00:00Z&to=2026-12-11T00:00:00Z')).data.events.filter((e) => e.title.startsWith('Dentist')).length, 0);

  // Contacts
  const cAdd = await p.sync('con', { commands: [E('AirSync:Add', [E('AirSync:ClientId', 'c1'), E('AirSync:ApplicationData', [
    E('Contacts:FirstName', 'Ravi'), E('Contacts:LastName', 'Kumar'), E('Contacts:Email1Address', '"Ravi Kumar" <ravi@example.in>'),
    E('Contacts:MobilePhoneNumber', '+91 98200 00000'), E('Contacts:CompanyName', 'Tata')])])] });
  const conSid = textOf(child(cAdd.responses, 'AirSync:Add'), 'AirSync:ServerId');
  const contacts = (await kai('/contacts')).data.contacts;
  const ravi = contacts.find((c) => c.email === 'ravi@example.in');
  assert.equal(ravi.name, 'Ravi Kumar');
  assert.equal(ravi.phone, '+91 98200 00000');
  await p.sync('con', { commands: [E('AirSync:Change', [E('AirSync:ServerId', conSid), E('AirSync:ApplicationData', [
    E('Contacts:FirstName', 'Ravi'), E('Contacts:LastName', 'Kumar'), E('Contacts:Email1Address', 'ravi@example.in'), E('Contacts:JobTitle', 'CFO')])])] });
  assert.equal((await kai('/contacts')).data.contacts.find((c) => c.email === 'ravi@example.in').job_title, 'CFO');

  // Tasks
  const tAdd = await p.sync('task', { commands: [E('AirSync:Add', [E('AirSync:ClientId', 't1'), E('AirSync:ApplicationData', [
    E('Tasks:Subject', 'File GST return'), E('Tasks:Importance', 2), E('Tasks:UtcDueDate', '2026-12-20T00:00:00.000Z'), E('Tasks:DueDate', '2026-12-20T00:00:00.000Z'), E('Tasks:Complete', 0)])])] });
  const taskSid = textOf(child(tAdd.responses, 'AirSync:Add'), 'AirSync:ServerId');
  const tasks = (await kai('/tasks')).data.tasks;
  const gst = tasks.find((t) => t.title === 'File GST return');
  assert.equal(!!gst.important, true);
  assert.equal(gst.due_at, '2026-12-20T00:00:00.000Z');
  await p.sync('task', { commands: [E('AirSync:Change', [E('AirSync:ServerId', taskSid), E('AirSync:ApplicationData', [E('Tasks:Subject', 'File GST return'), E('Tasks:Complete', 1), E('Tasks:DateCompleted', '2026-12-18T10:00:00.000Z')])])] });
  assert.ok((await kai('/tasks')).data.tasks.find((t) => t.title === 'File GST return').completed_at);

  // A meeting invitation from Lin: shows as a meeting request, accepted from the phone
  await lin('/calendar/events', { title: 'Quarterly review', start_at: '2026-12-15T05:30:00Z', end_at: '2026-12-15T06:30:00Z', attendees: ['kai@arzio.test'] });
  const fs1 = await p.folderSync();
  void fs1;
  const inbox = 'f' + (await kai('/folders')).data.folders.find((f) => f.role === 'inbox').id;
  await p.sync(inbox);
  const s = await p.sync(inbox);
  const inv = s.adds.find((a) => /Quarterly review/.test(textOf(app_(a), 'Email:Subject')));
  assert.equal(textOf(app_(inv), 'Email:MessageClass'), 'IPM.Schedule.Meeting.Request');
  assert.ok(child(app_(inv), 'Email:MeetingRequest'));
  const mr = await p.cmd('MeetingResponse', E('MeetingResponse:MeetingResponse', [E('MeetingResponse:Request', [E('MeetingResponse:UserResponse', 1), E('MeetingResponse:CollectionId', inbox), E('MeetingResponse:RequestId', sidOf(inv))])]));
  const result = child(mr.body, 'MeetingResponse:Result');
  assert.equal(textOf(result, 'MeetingResponse:Status'), '1');
  assert.match(textOf(result, 'MeetingResponse:CalendarId'), /^cal:\d+$/);
  const kaiEv = (await kai('/calendar/events?from=2026-12-15T00:00:00Z&to=2026-12-16T00:00:00Z')).data.events.find((e) => e.title === 'Quarterly review');
  assert.equal(kaiEv.my_status, 'accepted');
  const linEv = (await lin('/calendar/events?from=2026-12-15T00:00:00Z&to=2026-12-16T00:00:00Z')).data.events.find((e) => e.title === 'Quarterly review');
  assert.equal(linEv.attendees.find((a) => a.email === 'kai@arzio.test').status, 'accepted');
});

test('folders from the phone, search, out of office, remote wipe', async () => {
  const p = phone('kai@arzio.test', 'KAIPHONE8');
  await p.provision();
  const f = await p.folderSync();
  const fc = await p.cmd('FolderCreate', E('FolderHierarchy:FolderCreate', [E('FolderHierarchy:SyncKey', f.key), E('FolderHierarchy:ParentId', '0'), E('FolderHierarchy:DisplayName', 'Receipts'), E('FolderHierarchy:Type', 12)]));
  assert.equal(textOf(fc.body, 'FolderHierarchy:Status'), '1');
  const newId = textOf(fc.body, 'FolderHierarchy:ServerId');
  assert.ok((await kai('/folders')).data.folders.some((x) => x.name === 'Receipts'));
  const after = await p.folderSync(textOf(fc.body, 'FolderHierarchy:SyncKey'));
  assert.equal(after.adds.length, 0, 'not sent twice');
  const fu = await p.cmd('FolderUpdate', E('FolderHierarchy:FolderUpdate', [E('FolderHierarchy:SyncKey', after.key), E('FolderHierarchy:ServerId', newId), E('FolderHierarchy:ParentId', '0'), E('FolderHierarchy:DisplayName', 'Bills')]));
  assert.equal(textOf(fu.body, 'FolderHierarchy:Status'), '1');
  const fd = await p.cmd('FolderDelete', E('FolderHierarchy:FolderDelete', [E('FolderHierarchy:SyncKey', textOf(fu.body, 'FolderHierarchy:SyncKey')), E('FolderHierarchy:ServerId', newId)]));
  assert.equal(textOf(fd.body, 'FolderHierarchy:Status'), '1');
  const inboxF = f.adds.find((x) => x.type === '2');
  const noInbox = await p.cmd('FolderDelete', E('FolderHierarchy:FolderDelete', [E('FolderHierarchy:SyncKey', textOf(fd.body, 'FolderHierarchy:SyncKey')), E('FolderHierarchy:ServerId', inboxF.id)]));
  assert.equal(textOf(noInbox.body, 'FolderHierarchy:Status'), '3', 'Inbox cannot be deleted');
  // A folder created on the web shows up in the next FolderSync
  await kai('/folders', { name: 'Travel' });
  const fs2 = await p.folderSync(textOf(fd.body, 'FolderHierarchy:SyncKey'));
  assert.deepEqual(fs2.adds.map((x) => x.name), ['Travel']);

  // Directory search: free accounts see only their own contacts, never other signups
  const gal = await p.cmd('Search', E('Search:Search', [E('Search:Store', [E('Search:Name', 'GAL'), E('Search:Query', 'lin'), E('Search:Options', [E('Search:Range', '0-9')])])]));
  const galStore = child(child(gal.body, 'Search:Response'), 'Search:Store');
  const found = kids(galStore, 'Search:Result').map((r) => textOf(child(r, 'Search:Properties'), 'GAL:EmailAddress'));
  assert.deepEqual(found, [], 'another free account is not listed (Kai only wrote to Lin, never saved her)');
  const ravi = await p.cmd('Search', E('Search:Search', [E('Search:Store', [E('Search:Name', 'GAL'), E('Search:Query', 'ravi'), E('Search:Options', [E('Search:Range', '0-9')])])]));
  assert.deepEqual(kids(child(child(ravi.body, 'Search:Response'), 'Search:Store'), 'Search:Result').map((r) => textOf(child(r, 'Search:Properties'), 'GAL:EmailAddress')), ['ravi@example.in']);
  // Mailbox search
  const ms = await p.cmd('Search', E('Search:Search', [E('Search:Store', [E('Search:Name', 'Mailbox'), E('Search:Query', [E('Search:And', [E('AirSync:Class', 'Email'), E('Search:FreeText', 'lakh')])]), E('Search:Options', [E('Search:Range', '0-9'), E('AirSyncBase:BodyPreference', [E('AirSyncBase:Type', 1), E('AirSyncBase:TruncationSize', 500)])])])]));
  const msStore = child(child(ms.body, 'Search:Response'), 'Search:Store');
  assert.ok(Number(textOf(msStore, 'Search:Total')) >= 1);
  assert.ok(kids(msStore, 'Search:Result').some((r) => textOf(child(r, 'Search:Properties'), 'Email:Subject') === 'Budget'));

  // Out of office from the phone
  const set = await p.cmd('Settings', E('Settings:Settings', [E('Settings:Oof', [E('Settings:Set', [E('Settings:OofState', 1), E('Settings:OofMessage', [E('Settings:AppliesToInternal'), E('Settings:Enabled', 1), E('Settings:ReplyMessage', 'On leave until Monday'), E('Settings:BodyType', 'Text')])])])]));
  assert.equal(textOf(child(set.body, 'Settings:Oof'), 'Settings:Status'), '1');
  const me = (await kai('/me')).data;
  assert.equal(!!(me.user || me).ooo_enabled, true);
  const get = await p.cmd('Settings', E('Settings:Settings', [E('Settings:Oof', [E('Settings:Get', [E('Settings:BodyType', 'Text')])]), E('Settings:UserInformation', [E('Settings:Get')])]));
  const oofGet = child(child(get.body, 'Settings:Oof'), 'Settings:Get');
  assert.equal(textOf(oofGet, 'Settings:OofState'), '1');
  assert.equal(textOf(child(oofGet, 'Settings:OofMessage'), 'Settings:ReplyMessage'), 'On leave until Monday');
  assert.match(JSON.stringify(get.body), /kai@arzio\.test/);

  // Remote wipe from Settings: the phone is told to wipe and confirms
  const dev = (await kai('/me/devices')).data.devices.find((d) => d.device_id === 'KAIPHONE8');
  assert.equal((await kai(`/me/devices/${dev.id}`, { action: 'wipe' })).status, 200);
  const blocked = await p.folderSync(after.key);
  assert.equal(blocked.status, '144');
  const w = await p.cmd('Provision', E('Provision:Provision', [E('Provision:Policies', [E('Provision:Policy', [E('Provision:PolicyType', 'MS-EAS-Provisioning-WBXML')])])]));
  assert.ok(child(w.body, 'Provision:RemoteWipe'));
  await p.cmd('Provision', E('Provision:Provision', [E('Provision:RemoteWipe', [E('Provision:Status', 1)])]));
  assert.equal((await kai('/me/devices')).data.devices.find((d) => d.device_id === 'KAIPHONE8').status, 'wiped');

  // Blocking a phone refuses it; removing it lets it set up again
  const p9 = phone('kai@arzio.test', 'KAIPHONE9');
  await p9.provision();
  const d9 = (await kai('/me/devices')).data.devices.find((d) => d.device_id === 'KAIPHONE9');
  await kai(`/me/devices/${d9.id}`, { action: 'block' });
  assert.equal((await p9.cmd('FolderSync', E('FolderHierarchy:FolderSync', [E('FolderHierarchy:SyncKey', '0')]))).status, 403);
  await kai(`/me/devices/${d9.id}`, { action: 'remove' });
  await p9.provision();
  assert.equal((await p9.folderSync()).status, '1');
});

test('base64-encoded query strings (used by some phones)', async () => {
  const p = phone('lin@arzio.test', 'LINPHONE1');
  await p.provision();
  const dev = Buffer.from('LINPHONE1');
  void dev;
  // version 141, command 9 (FolderSync), locale, device id bytes, policy key, device type, User parameter
  const devId = Buffer.from('a1b2c3d4', 'hex');
  const key = Buffer.alloc(4); key.writeUInt32LE(0, 0);
  const user = Buffer.from('lin@arzio.test');
  const q = Buffer.concat([Buffer.from([141, 9, 0x09, 0x04, devId.length]), devId, Buffer.from([0]), Buffer.from([6]), Buffer.from('iPhone'), Buffer.from([8, user.length]), user]);
  const res = await fetch(`${root}/Microsoft-Server-ActiveSync?${encodeURIComponent(q.toString('base64'))}`, { method: 'POST', headers: { authorization: basic('lin@arzio.test'), 'content-type': 'application/vnd.ms-sync.wbxml' }, body: encode(E('FolderHierarchy:FolderSync', [E('FolderHierarchy:SyncKey', '0')])) });
  assert.equal(res.status, 200);
  const body = decode(Buffer.from(await res.arrayBuffer()));
  assert.equal(textOf(body, 'FolderHierarchy:Status'), '142', 'a new device id must provision first');
  assert.ok((await lin('/me/devices')).data.devices.some((d) => d.device_id === 'A1B2C3D4'));
});
