// Phase 5: CalDAV/CardDAV sync, health/readiness/metrics, backup and restore.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-p5-'));
const dataDir = path.join(dir, 'data');
Object.assign(process.env, { ARZIO_DATA_DIR: dataDir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log', ARZIO_MIN_FREE_MB: '1' });
const { app } = await import('../src/server.js');

let root; let web;
const basic = (email, pw = 'password123') => 'Basic ' + Buffer.from(`${email}:${pw}`).toString('base64');
const dav = (method, p, { body, auth = basic('mia@arzio.test'), headers = {} } = {}) =>
  fetch(root + p, { method, redirect: 'manual', headers: { authorization: auth, ...(body ? { 'content-type': 'text/xml' } : {}), ...headers }, body });

before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  root = `http://127.0.0.1:${server.address().port}`;
  server.unref();
  let cookie = '';
  web = async (p, body, method) => {
    const res = await fetch(root + '/api' + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await web('/auth/signup', { username: 'mia', name: 'Mia Ross', password: 'password123' })).status, 201);
  await fetch(root + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'noah', name: 'Noah', password: 'password123' }) });
});

const ICS = (uid, summary, start = '20261201T090000Z', end = '20261201T100000Z') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:20261124T000000Z`,
  `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

test('CalDAV: discovery, create from a phone, sync, edit, delete', async () => {
  const wk = await dav('PROPFIND', '/.well-known/caldav');
  assert.equal(wk.status, 301);
  assert.equal(wk.headers.get('location'), '/dav/');
  assert.equal((await dav('PROPFIND', '/dav/', { auth: basic('mia@arzio.test', 'nope') })).status, 401);

  const p = await dav('PROPFIND', '/dav/', { body: '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', headers: { depth: '0' } });
  assert.equal(p.status, 207);
  const px = await p.text();
  assert.match(px, /calendar-home-set><d:href>\/dav\/calendars\/mia@arzio.test\//);

  const home = await (await dav('PROPFIND', '/dav/calendars/mia@arzio.test/', { headers: { depth: '1' } })).text();
  assert.match(home, /<cal:calendar\/>/);
  const ctag1 = home.match(/getctag>([^<]+)/)[1];

  // The phone creates an event
  const put = await dav('PUT', '/dav/calendars/mia@arzio.test/default/phone-1.ics', { body: ICS('phone-1@iphone', 'Dentist'), headers: { 'content-type': 'text/calendar', 'if-none-match': '*' } });
  assert.equal(put.status, 201);
  const etag = put.headers.get('etag');
  assert.ok(etag);
  const ev = (await web('/calendar/events?from=2026-11-30T00:00:00Z&to=2026-12-03T00:00:00Z')).data.events.find((e) => e.title === 'Dentist');
  assert.ok(ev, 'shows up in the web calendar');
  assert.equal(ev.reminder_minutes, 15);

  // The web app creates one; the phone sees it on the next sync
  await web('/calendar/events', { title: 'Team lunch', start_at: '2026-12-02T12:00:00Z', end_at: '2026-12-02T13:00:00Z' });
  const coll = await (await dav('PROPFIND', '/dav/calendars/mia@arzio.test/default/', { headers: { depth: '1' } })).text();
  assert.notEqual(coll.match(/getctag>([^<]+)/)[1], ctag1, 'ctag changes');
  assert.equal((coll.match(/<d:getetag>/g) || []).length, 2);
  const rep = await (await dav('REPORT', '/dav/calendars/mia@arzio.test/default/', { headers: { depth: '1' },
    body: '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261202T000000Z" end="20261203T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>' })).text();
  assert.match(rep, /SUMMARY:Team lunch/);
  assert.doesNotMatch(rep, /Dentist/, 'time range filter applied');
  const mg = await (await dav('REPORT', '/dav/calendars/mia@arzio.test/default/', {
    body: '<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><d:href>/dav/calendars/mia@arzio.test/default/phone-1.ics</d:href></c:calendar-multiget>' })).text();
  assert.match(mg, /Dentist/);
  assert.match(mg, /TRIGGER:-PT15M/);

  // Edit with a stale ETag fails; with the right one it works
  assert.equal((await dav('PUT', '/dav/calendars/mia@arzio.test/default/phone-1.ics', { body: ICS('phone-1@iphone', 'Dentist (moved)'), headers: { 'if-match': '"stale"' } })).status, 412);
  const upd = await dav('PUT', '/dav/calendars/mia@arzio.test/default/phone-1.ics', { body: ICS('phone-1@iphone', 'Dentist (moved)', '20261201T150000Z', '20261201T160000Z'), headers: { 'if-match': etag } });
  assert.equal(upd.status, 204);
  const got = await dav('GET', '/dav/calendars/mia@arzio.test/default/phone-1.ics');
  assert.match(await got.text(), /SUMMARY:Dentist \(moved\)/);

  // Another user cannot read Mia's calendar
  assert.equal((await dav('PROPFIND', '/dav/calendars/mia@arzio.test/', { auth: basic('noah@arzio.test') })).status, 403);

  assert.equal((await dav('DELETE', '/dav/calendars/mia@arzio.test/default/phone-1.ics')).status, 204);
  const left = (await web('/calendar/events?from=2026-11-30T00:00:00Z&to=2026-12-03T00:00:00Z')).data.events;
  assert.ok(!left.some((e) => e.title.startsWith('Dentist')));
});

test('CardDAV: contacts sync both ways', async () => {
  const wk = await dav('PROPFIND', '/.well-known/carddav');
  assert.equal(wk.status, 301);
  const vc = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c-1\r\nFN:Priya Shah\r\nN:Shah;Priya;;;\r\nEMAIL;TYPE=INTERNET:priya@globex.test\r\nTEL;TYPE=CELL:+91 98765 43210\r\nORG:Globex\r\nEND:VCARD\r\n';
  const put = await dav('PUT', '/dav/addressbooks/mia@arzio.test/default/c-1.vcf', { body: vc, headers: { 'content-type': 'text/vcard' } });
  assert.equal(put.status, 201);
  const list = (await web('/contacts')).data.contacts;
  const c = list.find((x) => x.email === 'priya@globex.test');
  assert.ok(c && c.company === 'Globex' && c.phone === '+91 98765 43210');

  const noEmail = await dav('PUT', '/dav/addressbooks/mia@arzio.test/default/c-2.vcf', { body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c-2\r\nFN:Plumber\r\nTEL:12345\r\nEND:VCARD\r\n' });
  assert.equal(noEmail.status, 201);
  const back = await (await dav('GET', '/dav/addressbooks/mia@arzio.test/default/c-2.vcf')).text();
  assert.match(back, /FN:Plumber/);
  assert.doesNotMatch(back, /EMAIL/, 'placeholder address is never sent to the phone');

  const rep = await (await dav('REPORT', '/dav/addressbooks/mia@arzio.test/default/', { body: '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>' })).text();
  assert.match(rep, /FN:Priya Shah/);
  assert.match(rep, /FN:Plumber/);
  assert.equal((await dav('DELETE', '/dav/addressbooks/mia@arzio.test/default/c-2.vcf')).status, 204);
  assert.equal((await dav('GET', '/dav/addressbooks/mia@arzio.test/default/c-2.vcf')).status, 404);
});

test('health, readiness and metrics', async () => {
  const h = await (await fetch(root + '/health')).json();
  assert.equal(h.ok, true);
  const r = await fetch(root + '/ready');
  assert.equal(r.status, 200);
  const rj = await r.json();
  assert.ok(rj.checks.database.ok && rj.checks.storage.ok && rj.checks.disk.ok);
  const m = await fetch(root + '/metrics');
  assert.equal(m.status, 200, 'localhost may read metrics');
  const text = await m.text();
  assert.match(text, /^arzio_users 2$/m);
  assert.match(text, /arzio_outbound_queue\{status="pending"\}/);
  process.env.METRICS_TOKEN = 'secret-token';
  assert.equal((await fetch(root + '/metrics')).status, 403);
  assert.equal((await fetch(root + '/metrics', { headers: { authorization: 'Bearer secret-token' } })).status, 200);
  delete process.env.METRICS_TOKEN;
});

test('backup while running, then restore into a fresh folder', async () => {
  const out = path.join(dir, 'backups');
  const env = { ...process.env, ARZIO_DATA_DIR: dataDir };
  for (let i = 0; i < 3; i++) {
    const b = spawnSync(process.execPath, ['--no-warnings', 'scripts/backup.js', '--out', out, '--keep', '2'], { env, encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /Backup written/);
    await new Promise((res) => setTimeout(res, 1100)); // distinct timestamps
  }
  const files = fs.readdirSync(out).filter((f) => f.endsWith('.tar.gz'));
  assert.equal(files.length, 2, 'rotation keeps the newest 2');
  const target = path.join(dir, 'restored');
  const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/restore.js', path.join(out, files.sort().at(-1))], { env: { ...process.env, ARZIO_DATA_DIR: target }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(target, 'arzio.db')));
  const again = spawnSync(process.execPath, ['--no-warnings', 'scripts/restore.js', path.join(out, files[0])], { env: { ...process.env, ARZIO_DATA_DIR: target }, encoding: 'utf8' });
  assert.notEqual(again.status, 0, 'refuses to overwrite without --force');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(target, 'arzio.db'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  db.close();
});
