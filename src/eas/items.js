// Converts Arzio mail, calendar events, contacts and tasks to and from
// ActiveSync ApplicationData (MS-ASEMAIL, MS-ASCAL, MS-ASCNTC, MS-ASTASK).
import crypto from 'node:crypto';
import { db } from '../db.js';
import * as store from '../mail/store.js';
import * as blobs from '../blobs.js';
import { rawOf } from '../mail/imap.js';
import { E, child, kids, textOf } from './wbxml.js';

export const hash = (v) => crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);

// ------------------------------------------------------------ dates
/** 20261124T072200Z, the compact form calendars use */
export const compact = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export const isoMs = (iso) => new Date(iso).toISOString();
export function parseTime(s) {
  if (!s) return null;
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z?$/.exec(s.trim());
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
// TIME_ZONE_INFORMATION (172 bytes); all zeros is UTC
export const UTC_TZ = Buffer.alloc(172).toString('base64');
export function tzBias(b64) {
  try { const b = Buffer.from(b64 || '', 'base64'); return b.length >= 4 ? b.readInt32LE(0) : 0; } catch { return 0; }
}

/** Date cut-off for a Sync FilterType (0 = everything) */
export function filterCutoff(type, kind) {
  const days = { 1: 1, 2: 3, 3: 7, 4: 14, 5: 31, 6: 92, 7: 183 }[Number(type)];
  if (!days || kind === 'contacts' || kind === 'tasks') return null;
  return new Date(Date.now() - days * 86400e3).toISOString();
}

// ------------------------------------------------------------ bodies (AirSyncBase:Body)
function truncate(str, size) {
  const buf = Buffer.from(str, 'utf8');
  if (!size || buf.length <= size) return { data: str, truncated: false, size: buf.length };
  return { data: buf.subarray(0, size).toString('utf8').replace(/�$/, ''), truncated: true, size: buf.length };
}
/**
 * Picks the body type the client prefers that we can produce.
 * prefs: [{ type, size, allOrNone }] from Options/BodyPreference
 */
export function bodyNode({ text, html, mime }, prefs, { allowMime = false } = {}) {
  const want = (prefs?.length ? prefs : [{ type: 1 }]).find((p) => (p.type === 4 ? allowMime && mime : p.type === 1 || p.type === 2 || p.type === 3)) || { type: 1 };
  let type = want.type === 3 ? 1 : want.type;
  let content;
  if (type === 4) content = mime().toString('utf8');
  else if (type === 2) content = html || `<pre>${String(text || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`;
  else { type = 1; content = text || store.htmlToText(html || ''); }
  const t = truncate(content, want.allOrNone && Buffer.byteLength(content) > (want.size || Infinity) ? 0 : want.size);
  if (want.allOrNone && t.truncated) return E('AirSyncBase:Body', [E('AirSyncBase:Type', type), E('AirSyncBase:EstimatedDataSize', t.size), E('AirSyncBase:Truncated', 1)]);
  return E('AirSyncBase:Body', [
    E('AirSyncBase:Type', type), E('AirSyncBase:EstimatedDataSize', t.size),
    t.truncated ? E('AirSyncBase:Truncated', 1) : null, E('AirSyncBase:Data', t.data),
  ]);
}
export function readBodyPrefs(options) {
  return kids(options, 'AirSyncBase:BodyPreference').map((p) => ({
    type: Number(textOf(p, 'AirSyncBase:Type') || 1),
    size: Number(textOf(p, 'AirSyncBase:TruncationSize') || 0) || 0,
    allOrNone: textOf(p, 'AirSyncBase:AllOrNone') === '1',
  }));
}
const bodyText = (app, legacyTag) => {
  const b = child(app, 'AirSyncBase:Body');
  if (b) {
    const data = textOf(b, 'AirSyncBase:Data') || '';
    return Number(textOf(b, 'AirSyncBase:Type')) === 2 ? store.htmlToText(data) : data;
  }
  return textOf(app, legacyTag) ?? null;
};

// ------------------------------------------------------------ mail
const addrStr = (list) => (list || []).map((p) => (p.name ? `"${p.name.replace(/"/g, '')}" <${p.address}>` : p.address)).join(', ');

export function mailVersion(r) { return `${r.is_read ? 1 : 0}${r.is_flagged ? 1 : 0}`; }

export function mailItems(userId, folderId, cutoff) {
  const rows = db.prepare(`SELECT id, is_read, is_flagged FROM messages WHERE user_id = ? AND folder_id = ?${cutoff ? ' AND date >= ?' : ''} ORDER BY date DESC`)
    .all(...[userId, folderId, cutoff].filter((v) => v !== null && v !== undefined));
  const out = new Map();
  for (const r of rows) out.set(`${folderId}:${r.id}`, mailVersion(r));
  return out;
}

export async function mailData(userId, msgId, opts) {
  const m = store.getMessage(userId, msgId);
  if (!m) return null;
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id);
  let mimeBuf = null;
  if ((opts.bodyPrefs || []).some((p) => p.type === 4) && opts.mimeSupport > 0) mimeBuf = await rawOf(row);
  const invite = m.calendar && !m.calendar.stale && m.calendar.method === 'REQUEST' && !m.calendar.removed ? db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(m.calendar.eventId, userId) : null;
  const atts = m.attachments.filter((a) => !/^text\/calendar/i.test(a.content_type));
  return [
    E('Email:To', addrStr(m.to)), m.cc?.length ? E('Email:Cc', addrStr(m.cc)) : null,
    E('Email:From', addrStr([{ name: m.from_name, address: m.from_addr }])),
    E('Email:Subject', m.subject || ''),
    E('Email:DateReceived', isoMs(m.date)),
    E('Email:DisplayTo', (m.to || []).map((p) => p.name || p.address).join('; ')),
    E('Email:ThreadTopic', String(m.subject || '').replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, '')),
    E('Email:Importance', 1),
    E('Email:Read', m.is_read ? 1 : 0),
    atts.length ? E('AirSyncBase:Attachments', atts.map((a) => E('AirSyncBase:Attachment', [
      E('AirSyncBase:DisplayName', a.filename), E('AirSyncBase:FileReference', `att:${a.id}`), E('AirSyncBase:Method', 1), E('AirSyncBase:EstimatedDataSize', a.size),
    ]))) : null,
    bodyNode({ text: m.text_body, html: m.html_body, mime: () => mimeBuf }, opts.bodyPrefs, { allowMime: !!mimeBuf }),
    E('Email:MessageClass', invite ? 'IPM.Schedule.Meeting.Request' : 'IPM.Note'),
    invite ? E('Email:MeetingRequest', [
      E('Email:AllDayEvent', invite.all_day ? 1 : 0), E('Email:StartTime', isoMs(invite.start_at)), E('Email:DTStamp', isoMs(new Date())),
      E('Email:EndTime', isoMs(invite.end_at)), E('Email:InstanceType', 0), E('Email:Location', invite.location || ''),
      E('Email:Organizer', addrStr([{ name: invite.organizer_name, address: invite.organizer_email }])), E('Email:ResponseRequested', 1),
      E('Email:Sensitivity', 0), E('Email:BusyStatus', 2), E('Email:TimeZone', UTC_TZ),
    ]) : null,
    E('Email:InternetCPID', 65001),
    m.is_flagged ? E('Email:Flag', [E('Email:FlagStatus', 2), E('Email:FlagType', 'Flag for follow up')]) : E('Email:Flag'),
    E('Email:ContentClass', 'urn:content-classes:message'),
    E('AirSyncBase:NativeBodyType', m.html_body ? 2 : 1),
  ];
}

/** Client changes to a message: read state and follow-up flag */
export function applyMailChange(userId, msgId, app) {
  const patch = {};
  const read = textOf(app, 'Email:Read');
  if (read !== undefined) patch.is_read = read === '1';
  const flag = child(app, 'Email:Flag');
  if (flag) patch.is_flagged = textOf(flag, 'Email:FlagStatus') === '2';
  return store.updateMessage(userId, msgId, patch);
}

// ------------------------------------------------------------ calendar
const BUSY = { free: 0, tentative: 1, busy: 2, oof: 3 };
const BUSY_IN = ['free', 'tentative', 'busy', 'oof'];
const ATT_STATUS = { accepted: 3, tentative: 2, declined: 4, 'needs-action': 5 };
const RESPONSE = { organizer: 1, tentative: 2, accepted: 3, declined: 4, 'needs-action': 5 };

export const eventVersion = (r) => hash({ ...r, reminded_for: null, dav_name: null });
export function eventItems(userId, cutoff) {
  const rows = db.prepare("SELECT * FROM events WHERE user_id = ? AND cancelled = 0 ORDER BY start_at DESC").all(userId);
  const out = new Map();
  for (const r of rows) if (!cutoff || r.end_at >= cutoff || r.recurrence !== 'none') out.set(`cal:${r.id}`, eventVersion(r));
  return out;
}
export function eventData(userId, id, opts) {
  const r = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(id, userId);
  if (!r) return null;
  const atts = JSON.parse(r.attendees_json || '[]');
  const start = new Date(r.start_at);
  const rec = r.recurrence !== 'none' ? E('Calendar:Recurrence', [
    E('Calendar:Type', { daily: 0, weekly: 1, monthly: 2, yearly: 5 }[r.recurrence]), E('Calendar:Interval', 1),
    r.recur_until ? E('Calendar:Until', compact(r.recur_until)) : null,
    r.recurrence === 'weekly' ? E('Calendar:DayOfWeek', 1 << start.getUTCDay()) : null,
    r.recurrence === 'monthly' || r.recurrence === 'yearly' ? E('Calendar:DayOfMonth', start.getUTCDate()) : null,
    r.recurrence === 'yearly' ? E('Calendar:MonthOfYear', start.getUTCMonth() + 1) : null,
  ]) : null;
  const meeting = r.my_status === 'organizer' ? (atts.length ? 1 : 0) : 3;
  return [
    E('Calendar:TimeZone', UTC_TZ),
    E('Calendar:DTStamp', compact(r.updated_at ? r.updated_at.replace(' ', 'T') + (r.updated_at.endsWith('Z') ? '' : 'Z') : new Date())),
    E('Calendar:StartTime', compact(r.start_at)),
    E('Calendar:Subject', r.title || ''),
    E('Calendar:UID', r.uid),
    r.organizer_name ? E('Calendar:OrganizerName', r.organizer_name) : null,
    r.organizer_email ? E('Calendar:OrganizerEmail', r.organizer_email) : null,
    atts.length ? E('Calendar:Attendees', atts.map((a) => E('Calendar:Attendee', [
      E('Calendar:Email', a.email), E('Calendar:Name', a.name || a.email), E('Calendar:AttendeeStatus', ATT_STATUS[a.status] ?? 0), E('Calendar:AttendeeType', 1),
    ]))) : null,
    E('Calendar:Location', r.location || ''),
    E('Calendar:EndTime', compact(r.end_at)),
    rec,
    bodyNode({ text: [r.description, r.online_url].filter(Boolean).join('\n\n'), html: '' }, (opts.bodyPrefs || []).filter((p) => p.type !== 4)),
    E('Calendar:Sensitivity', 0),
    E('Calendar:BusyStatus', BUSY[r.show_as] ?? 2),
    E('Calendar:AllDayEvent', r.all_day ? 1 : 0),
    r.reminder_minutes !== null && r.reminder_minutes !== undefined ? E('Calendar:Reminder', r.reminder_minutes) : null,
    E('Calendar:MeetingStatus', meeting),
    E('Calendar:ResponseRequested', meeting === 3 ? 1 : 0),
    E('Calendar:ResponseType', RESPONSE[r.my_status] ?? 0),
  ];
}
/** ApplicationData from the phone -> body for calendar/service.js */
export function readEvent(app) {
  const allDay = textOf(app, 'Calendar:AllDayEvent') === '1';
  let start = parseTime(textOf(app, 'Calendar:StartTime'));
  let end = parseTime(textOf(app, 'Calendar:EndTime'));
  if (allDay && start) {
    // Phones send local midnight as UTC; store the calendar date at 00:00 UTC
    const bias = tzBias(textOf(app, 'Calendar:TimeZone'));
    const day = (d) => new Date(new Date(d.getTime() - bias * 60e3).toISOString().slice(0, 10) + 'T00:00:00.000Z');
    start = day(start); end = end ? day(end) : new Date(start.getTime() + 86400e3);
  }
  const out = {};
  if (start) out.start_at = start.toISOString();
  if (end) out.end_at = end.toISOString();
  const subject = textOf(app, 'Calendar:Subject'); if (subject !== undefined) out.title = subject;
  const loc = textOf(app, 'Calendar:Location'); if (loc !== undefined) out.location = loc;
  const body = bodyText(app, 'Calendar:Body'); if (body !== null) out.description = body;
  if (textOf(app, 'Calendar:AllDayEvent') !== undefined) out.all_day = allDay;
  const rem = textOf(app, 'Calendar:Reminder'); out.reminder_minutes = rem === undefined || rem === '' ? null : Number(rem);
  const busy = textOf(app, 'Calendar:BusyStatus'); if (busy !== undefined) out.show_as = BUSY_IN[Number(busy)] || 'busy';
  const uid = textOf(app, 'Calendar:UID'); if (uid) out.uid = uid;
  const rec = child(app, 'Calendar:Recurrence');
  if (rec) {
    out.recurrence = { 0: 'daily', 1: 'weekly', 2: 'monthly', 3: 'monthly', 5: 'yearly', 6: 'yearly' }[textOf(rec, 'Calendar:Type')] || 'none';
    const until = parseTime(textOf(rec, 'Calendar:Until'));
    out.recur_until = until ? until.toISOString() : null;
  } else out.recurrence = 'none';
  const att = child(app, 'Calendar:Attendees');
  if (att) out.attendees = kids(att, 'Calendar:Attendee').map((a) => ({ email: textOf(a, 'Calendar:Email'), name: textOf(a, 'Calendar:Name') || '' })).filter((a) => a.email);
  return out;
}

// ------------------------------------------------------------ contacts
export const contactVersion = (r) => hash([r.email, r.name, r.phone, r.company, r.job_title, r.notes]);
export function contactItems(userId) {
  const out = new Map();
  for (const r of db.prepare('SELECT * FROM contacts WHERE user_id = ? AND is_saved = 1 ORDER BY id').all(userId)) out.set(`con:${r.id}`, contactVersion(r));
  return out;
}
export function contactData(userId, id) {
  const r = db.prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ? AND is_saved = 1').get(id, userId);
  if (!r) return null;
  const parts = String(r.name || '').trim().split(/\s+/).filter(Boolean);
  const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '';
  const last = parts.length > 1 ? parts.at(-1) : '';
  return [
    E('Contacts:FileAs', r.name || r.email), first ? E('Contacts:FirstName', first) : null, last ? E('Contacts:LastName', last) : null,
    r.email.endsWith('.invalid') ? null : E('Contacts:Email1Address', r.email),
    r.phone ? E('Contacts:MobilePhoneNumber', r.phone) : null, r.company ? E('Contacts:CompanyName', r.company) : null,
    r.job_title ? E('Contacts:JobTitle', r.job_title) : null,
    r.notes ? E('AirSyncBase:Body', [E('AirSyncBase:Type', 1), E('AirSyncBase:EstimatedDataSize', Buffer.byteLength(r.notes)), E('AirSyncBase:Data', r.notes)]) : null,
  ];
}
export function saveContact(userId, app, existingId) {
  const email1 = textOf(app, 'Contacts:Email1Address') || '';
  const addr = (/<([^>]+)>/.exec(email1)?.[1] || email1).trim().toLowerCase();
  const name = [textOf(app, 'Contacts:FirstName'), textOf(app, 'Contacts:MiddleName'), textOf(app, 'Contacts:LastName')].filter(Boolean).join(' ') || textOf(app, 'Contacts:FileAs') || '';
  const phone = textOf(app, 'Contacts:MobilePhoneNumber') || textOf(app, 'Contacts:BusinessPhoneNumber') || textOf(app, 'Contacts:HomePhoneNumber') || '';
  const vals = {
    name: name.slice(0, 200), phone: phone.slice(0, 50), company: (textOf(app, 'Contacts:CompanyName') || '').slice(0, 200),
    job_title: (textOf(app, 'Contacts:JobTitle') || '').slice(0, 200), notes: String(bodyText(app, 'Contacts:Body') || '').slice(0, 5000),
  };
  const existing = existingId ? db.prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?').get(existingId, userId) : null;
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : existing?.email || `${crypto.randomUUID().slice(0, 12)}@no-email.invalid`;
  if (existing) {
    const clash = db.prepare('SELECT id FROM contacts WHERE user_id = ? AND email = ? AND id <> ?').get(userId, email, existing.id);
    if (clash) db.prepare('DELETE FROM contacts WHERE id = ? AND is_saved = 0').run(clash.id);
    db.prepare('UPDATE contacts SET email = ?, name = ?, phone = ?, company = ?, job_title = ?, notes = ?, is_saved = 1 WHERE id = ?')
      .run(email, vals.name, vals.phone, vals.company, vals.job_title, vals.notes, existing.id);
    return existing.id;
  }
  db.prepare(`INSERT INTO contacts (user_id, email, name, phone, company, job_title, notes, is_saved, uid) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(user_id, email) DO UPDATE SET name = excluded.name, phone = excluded.phone, company = excluded.company, job_title = excluded.job_title, notes = excluded.notes, is_saved = 1`)
    .run(userId, email, vals.name, vals.phone, vals.company, vals.job_title, vals.notes, crypto.randomUUID());
  return db.prepare('SELECT id FROM contacts WHERE user_id = ? AND email = ?').get(userId, email).id;
}

// ------------------------------------------------------------ tasks
export const taskVersion = (r) => hash({ ...r, reminded: null });
export function taskItems(userId, filterType) {
  const out = new Map();
  for (const r of db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY id').all(userId)) {
    if (Number(filterType) === 8 && r.completed_at) continue;
    out.set(`task:${r.id}`, taskVersion(r));
  }
  return out;
}
export function taskData(userId, id) {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId);
  if (!r) return null;
  return [
    r.notes ? E('AirSyncBase:Body', [E('AirSyncBase:Type', 1), E('AirSyncBase:EstimatedDataSize', Buffer.byteLength(r.notes)), E('AirSyncBase:Data', r.notes)]) : null,
    E('Tasks:Subject', r.title),
    E('Tasks:Importance', r.important ? 2 : 1),
    r.due_at ? E('Tasks:UtcDueDate', isoMs(r.due_at)) : null, r.due_at ? E('Tasks:DueDate', isoMs(r.due_at)) : null,
    E('Tasks:Complete', r.completed_at ? 1 : 0),
    r.completed_at ? E('Tasks:DateCompleted', isoMs(r.completed_at.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(r.completed_at) ? '' : 'Z'))) : null,
    E('Tasks:Sensitivity', 0),
    E('Tasks:ReminderSet', r.reminder_at ? 1 : 0), r.reminder_at ? E('Tasks:ReminderTime', isoMs(r.reminder_at)) : null,
  ];
}
export function saveTask(userId, app, existingId) {
  const due = parseTime(textOf(app, 'Tasks:UtcDueDate') || textOf(app, 'Tasks:DueDate'));
  const remind = textOf(app, 'Tasks:ReminderSet') === '1' ? parseTime(textOf(app, 'Tasks:ReminderTime')) : null;
  const complete = textOf(app, 'Tasks:Complete') === '1';
  const done = complete ? (parseTime(textOf(app, 'Tasks:DateCompleted')) || new Date()).toISOString() : null;
  const vals = [String(textOf(app, 'Tasks:Subject') || '(no title)').slice(0, 500), String(bodyText(app, 'Tasks:Body') || '').slice(0, 10000),
    due ? due.toISOString() : null, remind ? remind.toISOString() : null, textOf(app, 'Tasks:Importance') === '2' ? 1 : 0, done];
  const existing = existingId ? db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(existingId, userId) : null;
  if (existing) {
    db.prepare('UPDATE tasks SET title = ?, notes = ?, due_at = ?, reminder_at = ?, important = ?, completed_at = ?, reminded = CASE WHEN reminder_at IS ? THEN reminded ELSE 0 END WHERE id = ?')
      .run(...vals, vals[3], existing.id);
    return existing.id;
  }
  return Number(db.prepare('INSERT INTO tasks (user_id, title, notes, due_at, reminder_at, important, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, ...vals).lastInsertRowid);
}

// ------------------------------------------------------------ attachments
export function attachmentFor(userId, fileRef) {
  const id = Number(String(fileRef || '').replace(/^att:/, ''));
  const a = id ? store.getAttachment(userId, id) : null;
  if (!a) return null;
  return { ...a, data: blobs.get(a.storage_path) };
}
