// CalDAV and CardDAV: sync Arzio calendars and contacts with iPhone / Mac
// (Calendar, Contacts), Android (DAVx5), Thunderbird and other apps.
// Account: your Arzio address and password (or an app password with two-step
// verification). Server: https://<host>/ (apps find /dav through /.well-known).
import express from 'express';
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { clientLogin } from './auth.js';
import { buildIcs, parseIcs } from './calendar/ics.js';
import * as cal from './calendar/service.js';
import { audit } from './audit.js';

const NS = 'xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';
const x = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

export const dav = express.Router();
dav.use(express.text({ type: () => true, limit: '5mb' }));

// ------------------------------------------------------------ auth (HTTP Basic, like every DAV client)
const failures = new Map();
function auth(req, res, next) {
  const m = String(req.headers.authorization || '').match(/^Basic\s+(\S+)$/i);
  const ip = req.ip;
  const recent = (failures.get(ip) || []).filter((t) => Date.now() - t < 15 * 60e3);
  failures.set(ip, recent);
  if (m && recent.length < 10) {
    const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    const u = clientLogin(user, rest.join(':'));
    if (u) { req.user = u; return next(); }
    recent.push(Date.now());
  }
  res.set('WWW-Authenticate', `Basic realm="${config.serviceName}", charset="UTF-8"`).status(401).send('Sign in with your email address and password (or app password).');
}

function multistatus(res, responses) {
  res.status(207).type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${NS}>${responses.join('')}</d:multistatus>`);
}
const response = (href, props) => `<d:response><d:href>${x(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const privileges = '<d:current-user-privilege-set><d:privilege><d:all/></d:privilege><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege></d:current-user-privilege-set>';

// ------------------------------------------------------------ calendar objects
function eventRows(userId) {
  return db.prepare('SELECT * FROM events WHERE user_id = ? AND cancelled = 0 ORDER BY id').all(userId);
}
const eventName = (r) => r.dav_name || `${encodeURIComponent(r.uid)}.ics`;
const eventEtag = (r) => `"${hash(JSON.stringify({ ...r, reminded_for: null }))}"`;
function eventIcs(userId, r) {
  return buildIcs({ method: null, events: [cal.getEvent(userId, r.id)] });
}
function findEvent(userId, name) {
  return db.prepare('SELECT * FROM events WHERE user_id = ? AND cancelled = 0 AND (dav_name = ? OR (dav_name IS NULL AND uid = ?))')
    .get(userId, name, decodeURIComponent(name.replace(/\.ics$/i, '')));
}

// ------------------------------------------------------------ contacts (vCard 3.0)
const vesc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n/g, '\\n');
const vunesc = (v) => String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
function contactRows(userId) {
  const rows = db.prepare('SELECT * FROM contacts WHERE user_id = ? AND is_saved = 1 ORDER BY id').all(userId);
  for (const r of rows) if (!r.uid) { r.uid = crypto.randomUUID(); db.prepare('UPDATE contacts SET uid = ? WHERE id = ?').run(r.uid, r.id); }
  return rows;
}
const contactName = (r) => r.dav_name || `${r.uid}.vcf`;
const contactEtag = (r) => `"${hash(JSON.stringify([r.email, r.name, r.phone, r.company, r.job_title, r.notes, r.uid]))}"`;
function vcard(r) {
  const parts = r.name.split(' ');
  return ['BEGIN:VCARD', 'VERSION:3.0', `UID:${r.uid}`, `FN:${vesc(r.name || r.email)}`, `N:${vesc(parts.length > 1 ? parts.at(-1) : r.name)};${vesc(parts.length > 1 ? parts.slice(0, -1).join(' ') : '')};;;`,
    r.email.endsWith('.invalid') ? null : `EMAIL;TYPE=INTERNET:${r.email}`, r.phone && `TEL;TYPE=CELL:${vesc(r.phone)}`, r.company && `ORG:${vesc(r.company)}`,
    r.job_title && `TITLE:${vesc(r.job_title)}`, r.notes && `NOTE:${vesc(r.notes)}`, 'END:VCARD'].filter(Boolean).join('\r\n') + '\r\n';
}
function parseVcard(text) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const key = l.slice(0, i).split(';')[0].toUpperCase().replace(/^item\d+\./i, '');
    const val = l.slice(i + 1);
    if (key === 'UID') out.uid = val.trim();
    if (key === 'FN') out.name = vunesc(val);
    if (key === 'EMAIL' && !out.email) out.email = val.trim().toLowerCase();
    if (key === 'TEL' && !out.phone) out.phone = vunesc(val);
    if (key === 'ORG' && !out.company) out.company = vunesc(val.split(';')[0]);
    if (key === 'TITLE') out.job_title = vunesc(val);
    if (key === 'NOTE') out.notes = vunesc(val);
  }
  return out;
}
function findContact(userId, name) {
  return db.prepare('SELECT * FROM contacts WHERE user_id = ? AND is_saved = 1 AND (dav_name = ? OR (dav_name IS NULL AND uid = ?))').get(userId, name, name.replace(/\.vcf$/i, ''));
}

// ------------------------------------------------------------ well-known discovery
export const wellKnown = express.Router();
wellKnown.all(['/.well-known/caldav', '/.well-known/carddav'], (req, res) => res.redirect(301, '/dav/'));

// ------------------------------------------------------------ routing
dav.options('/{*rest}', (req, res) => {
  res.set({ DAV: '1, 2, 3, calendar-access, addressbook', Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT' }).status(200).end();
});
dav.use(auth);

function parsePath(req) {
  const parts = decodeURIComponent(req.path).split('/').filter(Boolean);
  return { kind: parts[0] || '', owner: (parts[1] || '').toLowerCase(), coll: parts[2] || '', name: parts[3] || '' };
}

dav.use((req, res, next) => {
  const p = parsePath(req);
  if (p.owner && p.owner !== req.user.email) return res.status(403).send('You can only open your own calendars and contacts.');
  req.dav = p;
  next();
});

dav.all('/{*rest}', async (req, res, next) => {
  try {
    const m = req.method;
    if (m === 'PROPFIND') return propfind(req, res);
    if (m === 'REPORT') return report(req, res);
    if (m === 'GET' || m === 'HEAD') return get(req, res);
    if (m === 'PUT') return await put(req, res);
    if (m === 'DELETE') return await del(req, res);
    res.status(405).end();
  } catch (e) {
    next(e);
  }
});

function principalProps(u) {
  const me = `/dav/principals/${u.email}/`;
  return `<d:resourcetype><d:principal/><d:collection/></d:resourcetype><d:displayname>${x(u.name)}</d:displayname>
    <d:current-user-principal><d:href>${x(me)}</d:href></d:current-user-principal><d:principal-URL><d:href>${x(me)}</d:href></d:principal-URL>
    <cal:calendar-home-set><d:href>/dav/calendars/${x(u.email)}/</d:href></cal:calendar-home-set>
    <card:addressbook-home-set><d:href>/dav/addressbooks/${x(u.email)}/</d:href></card:addressbook-home-set>
    <cal:calendar-user-address-set><d:href>mailto:${x(u.email)}</d:href></cal:calendar-user-address-set>`;
}
function calCollectionProps(u) {
  const rows = eventRows(u.id);
  const ctag = hash(rows.map(eventEtag).join());
  return `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Calendar</d:displayname>
    <cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
    <cs:getctag>${ctag}</cs:getctag><d:owner><d:href>/dav/principals/${x(u.email)}/</d:href></d:owner>${privileges}`;
}
function cardCollectionProps(u) {
  const ctag = hash(contactRows(u.id).map(contactEtag).join());
  return `<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname>
    <cs:getctag>${ctag}</cs:getctag><d:owner><d:href>/dav/principals/${x(u.email)}/</d:href></d:owner>${privileges}`;
}

function propfind(req, res) {
  const u = req.user;
  const { kind, coll, name } = req.dav;
  const depth = String(req.headers.depth ?? '1');
  const out = [];
  const base = `/dav/${kind}/${u.email}/`;
  if (!kind || kind === 'principals') {
    out.push(response(kind ? `/dav/principals/${u.email}/` : '/dav/', principalProps(u)));
  } else if (kind === 'calendars') {
    if (!coll) {
      out.push(response(base, `<d:resourcetype><d:collection/></d:resourcetype><d:current-user-principal><d:href>/dav/principals/${x(u.email)}/</d:href></d:current-user-principal>`));
      if (depth !== '0') out.push(response(`${base}default/`, calCollectionProps(u)));
    } else if (coll !== 'default') return res.status(404).end();
    else if (!name) {
      out.push(response(`${base}default/`, calCollectionProps(u)));
      if (depth !== '0') for (const r of eventRows(u.id)) out.push(response(`${base}default/${eventName(r)}`, `<d:getetag>${x(eventEtag(r))}</d:getetag><d:getcontenttype>text/calendar; charset=utf-8; component=vevent</d:getcontenttype><d:resourcetype/>`));
    } else {
      const r = findEvent(u.id, name);
      if (!r) return res.status(404).end();
      out.push(response(`${base}default/${eventName(r)}`, `<d:getetag>${x(eventEtag(r))}</d:getetag><d:getcontenttype>text/calendar; charset=utf-8; component=vevent</d:getcontenttype><d:resourcetype/>`));
    }
  } else if (kind === 'addressbooks') {
    if (!coll) {
      out.push(response(base, `<d:resourcetype><d:collection/></d:resourcetype><d:current-user-principal><d:href>/dav/principals/${x(u.email)}/</d:href></d:current-user-principal>`));
      if (depth !== '0') out.push(response(`${base}default/`, cardCollectionProps(u)));
    } else if (coll !== 'default') return res.status(404).end();
    else if (!name) {
      out.push(response(`${base}default/`, cardCollectionProps(u)));
      if (depth !== '0') for (const r of contactRows(u.id)) out.push(response(`${base}default/${contactName(r)}`, `<d:getetag>${x(contactEtag(r))}</d:getetag><d:getcontenttype>text/vcard; charset=utf-8</d:getcontenttype><d:resourcetype/>`));
    } else {
      const r = findContact(u.id, name);
      if (!r) return res.status(404).end();
      out.push(response(`${base}default/${contactName(r)}`, `<d:getetag>${x(contactEtag(r))}</d:getetag><d:getcontenttype>text/vcard; charset=utf-8</d:getcontenttype><d:resourcetype/>`));
    }
  } else return res.status(404).end();
  multistatus(res, out);
}

function report(req, res) {
  const u = req.user;
  const { kind, coll } = req.dav;
  if (coll !== 'default') return res.status(404).end();
  const body = String(req.body || '');
  const hrefs = [...body.matchAll(/<(?:[a-z]+:)?href>([^<]+)<\/(?:[a-z]+:)?href>/gi)].map((m) => decodeURIComponent(m[1].trim()).split('/').pop());
  const multiget = /multiget/i.test(body);
  const base = `/dav/${kind}/${u.email}/default/`;
  const out = [];
  if (kind === 'calendars') {
    // calendar-query: optional time-range filter
    const tr = body.match(/time-range[^>]*start="(\d{8}T\d{6}Z)"[^>]*?(?:end="(\d{8}T\d{6}Z)")?/i);
    const toIso = (s) => s && `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
    let rows = multiget ? hrefs.map((h) => findEvent(u.id, h)).filter(Boolean) : eventRows(u.id);
    if (!multiget && tr) {
      const from = toIso(tr[1]);
      const to = toIso(tr[2]) || '9999-12-31T00:00:00Z';
      rows = rows.filter((r) => cal.occurrences(cal.getEvent(u.id, r.id), from, to).length);
    }
    for (const r of rows) out.push(response(`${base}${eventName(r)}`, `<d:getetag>${x(eventEtag(r))}</d:getetag><cal:calendar-data>${x(eventIcs(u.id, r))}</cal:calendar-data>`));
  } else if (kind === 'addressbooks') {
    const rows = multiget ? hrefs.map((h) => findContact(u.id, h)).filter(Boolean) : contactRows(u.id);
    for (const r of rows) out.push(response(`${base}${contactName(r)}`, `<d:getetag>${x(contactEtag(r))}</d:getetag><card:address-data>${x(vcard(r))}</card:address-data>`));
  } else return res.status(404).end();
  multistatus(res, out);
}

function get(req, res) {
  const u = req.user;
  const { kind, coll, name } = req.dav;
  if (coll !== 'default' || !name) {
    return res.type('text/plain').send(`${config.serviceName} CalDAV/CardDAV. Add this server to your calendar or contacts app with your email address and password.`);
  }
  if (kind === 'calendars') {
    const r = findEvent(u.id, name);
    if (!r) return res.status(404).end();
    return res.set('ETag', eventEtag(r)).type('text/calendar; charset=utf-8').send(eventIcs(u.id, r));
  }
  if (kind === 'addressbooks') {
    const r = findContact(u.id, name);
    if (!r) return res.status(404).end();
    return res.set('ETag', contactEtag(r)).type('text/vcard; charset=utf-8').send(vcard(r));
  }
  res.status(404).end();
}

function preconditionFails(req, existing, etagOf) {
  const im = req.headers['if-match'];
  const inm = req.headers['if-none-match'];
  if (inm === '*' && existing) return true;
  if (im && im !== '*' && (!existing || etagOf(existing) !== im)) return true;
  if (im === '*' && !existing) return true;
  return false;
}

async function put(req, res) {
  const u = req.user;
  const { kind, coll, name } = req.dav;
  if (coll !== 'default' || !name) return res.status(405).end();
  if (kind === 'calendars') {
    const { events } = parseIcs(String(req.body || ''));
    const e = events[0];
    if (!e?.start_at) return res.status(415).send('Expected an iCalendar event.');
    let existing = findEvent(u.id, name) || (e.uid && db.prepare('SELECT * FROM events WHERE user_id = ? AND uid = ? AND cancelled = 0').get(u.id, e.uid));
    if (preconditionFails(req, existing, eventEtag)) return res.status(412).end();
    const body = {
      uid: e.uid, title: e.title, description: e.description || '', location: e.location || '', start_at: e.start_at, end_at: e.end_at, all_day: e.all_day,
      recurrence: e.recurrence || 'none', recur_until: e.recur_until || null, online_url: e.online_url || '', show_as: e.show_as || 'busy',
      reminder_minutes: e.reminder_minutes ?? null,
      attendees: (e.attendees || []).filter((a) => a.email !== u.email && a.email !== e.organizer_email),
    };
    if (existing && existing.my_status !== 'organizer') {
      // An invitation: the app can change your response and your reminder
      const mine = (e.attendees || []).find((a) => a.email === u.email);
      if (mine && ['accepted', 'tentative', 'declined'].includes(mine.status) && mine.status !== existing.my_status) await cal.respond(u, existing.id, mine.status);
      if (body.reminder_minutes !== existing.reminder_minutes) await cal.updateEvent(u, existing.id, { reminder_minutes: body.reminder_minutes });
    } else if (existing) {
      await cal.updateEvent(u, existing.id, body);
    } else {
      const ev = await cal.createEvent(u, body);
      existing = { id: ev.id, created: true };
      audit(u.id, 'dav.event.create', { uid: ev.uid });
    }
    db.prepare('UPDATE events SET dav_name = ? WHERE id = ?').run(name, existing.id);
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(existing.id);
    return res.set('ETag', eventEtag(row)).status(existing.created ? 201 : 204).end();
  }
  if (kind === 'addressbooks') {
    const c = parseVcard(String(req.body || ''));
    if (!c.uid) c.uid = name.replace(/\.vcf$/i, '');
    const existing = findContact(u.id, name) || db.prepare('SELECT * FROM contacts WHERE user_id = ? AND uid = ?').get(u.id, c.uid);
    if (preconditionFails(req, existing, contactEtag)) return res.status(412).end();
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || '') ? c.email : `${hash(c.uid)}@no-email.invalid`;
    const vals = [email, String(c.name || '').slice(0, 200), String(c.phone || '').slice(0, 50), String(c.company || '').slice(0, 200), String(c.job_title || '').slice(0, 200), String(c.notes || '').slice(0, 5000)];
    if (existing) {
      db.prepare('UPDATE contacts SET email = ?, name = ?, phone = ?, company = ?, job_title = ?, notes = ?, is_saved = 1, uid = ?, dav_name = ? WHERE id = ?').run(...vals, c.uid, name, existing.id);
    } else {
      db.prepare(`INSERT INTO contacts (user_id, email, name, phone, company, job_title, notes, is_saved, uid, dav_name) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(user_id, email) DO UPDATE SET name = excluded.name, phone = excluded.phone, company = excluded.company, job_title = excluded.job_title, notes = excluded.notes, is_saved = 1, uid = excluded.uid, dav_name = excluded.dav_name`)
        .run(u.id, ...vals, c.uid, name);
    }
    const row = findContact(u.id, name);
    return res.set('ETag', contactEtag(row)).status(existing ? 204 : 201).end();
  }
  res.status(404).end();
}

async function del(req, res) {
  const u = req.user;
  const { kind, coll, name } = req.dav;
  if (coll !== 'default' || !name) return res.status(403).end();
  if (kind === 'calendars') {
    const r = findEvent(u.id, name);
    if (!r) return res.status(404).end();
    if (preconditionFails(req, r, eventEtag)) return res.status(412).end();
    await cal.deleteEvent(u, r.id);
    return res.status(204).end();
  }
  if (kind === 'addressbooks') {
    const r = findContact(u.id, name);
    if (!r) return res.status(404).end();
    db.prepare('DELETE FROM contacts WHERE id = ?').run(r.id);
    return res.status(204).end();
  }
  res.status(404).end();
}
