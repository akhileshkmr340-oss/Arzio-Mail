// Calendar: events, recurrence, meeting invites (iMIP), responses, free/busy,
// feeds, import, and reminders for events and tasks.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { buildIcs, parseIcs } from './ics.js';
import { performSend } from '../mail/delivery.js';

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const MAX_OCCURRENCES = 500;

function row2event(r) {
  return {
    id: r.id, uid: r.uid, title: r.title, location: r.location, description: r.description,
    start_at: r.start_at, end_at: r.end_at, all_day: !!r.all_day, recurrence: r.recurrence, recur_until: r.recur_until,
    organizer_email: r.organizer_email, organizer_name: r.organizer_name, attendees: JSON.parse(r.attendees_json || '[]'),
    my_status: r.my_status, sequence: r.sequence, online_url: r.online_url, reminder_minutes: r.reminder_minutes,
    show_as: r.show_as, cancelled: !!r.cancelled, color: r.color,
  };
}

export function getEvent(userId, id) {
  const r = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(Number(id), userId);
  return r ? row2event(r) : null;
}

function addInterval(d, rec, n) {
  const x = new Date(d);
  if (rec === 'daily') x.setUTCDate(x.getUTCDate() + n);
  if (rec === 'weekly') x.setUTCDate(x.getUTCDate() + 7 * n);
  if (rec === 'monthly') x.setUTCMonth(x.getUTCMonth() + n);
  if (rec === 'yearly') x.setUTCFullYear(x.getUTCFullYear() + n);
  return x;
}

/** Occurrences of one event that overlap [from, to). */
export function occurrences(e, from, to) {
  const start = new Date(e.start_at);
  const dur = new Date(e.end_at) - start;
  const f = new Date(from);
  const t = new Date(to);
  if (e.recurrence === 'none') return start < t && new Date(start.getTime() + dur) > f ? [{ ...e, occurrence: e.start_at }] : [];
  const out = [];
  const until = e.recur_until ? new Date(e.recur_until) : null;
  for (let i = 0; i < 5000 && out.length < MAX_OCCURRENCES; i++) {
    const s = addInterval(start, e.recurrence, i);
    if (s >= t || (until && s > until)) break;
    const en = new Date(s.getTime() + dur);
    if (en > f) out.push({ ...e, start_at: s.toISOString(), end_at: en.toISOString(), occurrence: s.toISOString() });
  }
  return out;
}

export function listEvents(userId, from, to) {
  const rows = db.prepare(`SELECT * FROM events WHERE user_id = ? AND cancelled = 0 AND (
      (recurrence = 'none' AND start_at < ? AND end_at > ?) OR (recurrence != 'none' AND start_at < ? AND (recur_until IS NULL OR recur_until > ?)))`)
    .all(userId, to, from, to, from);
  return rows.map(row2event).flatMap((e) => occurrences(e, from, to)).sort((a, b) => a.start_at.localeCompare(b.start_at));
}

function cleanEvent(b, existing = {}) {
  const title = String(b.title ?? existing.title ?? '').trim().slice(0, 300) || '(no title)';
  const start = new Date(b.start_at ?? existing.start_at);
  const end = new Date(b.end_at ?? existing.end_at ?? start.getTime() + 3600e3);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw httpErr(400, 'Enter a valid start and end time.');
  if (end < start) throw httpErr(400, 'The event ends before it starts.');
  const recurrence = ['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(b.recurrence) ? b.recurrence : existing.recurrence || 'none';
  const attendees = (b.attendees ?? existing.attendees ?? []).map((a) => (typeof a === 'string' ? { email: a } : a))
    .map((a) => ({ email: String(a.email || '').trim().toLowerCase(), name: String(a.name || ''), status: a.status || 'needs-action' }))
    .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)).slice(0, 200);
  return {
    title, start_at: start.toISOString(), end_at: end.toISOString(), all_day: !!(b.all_day ?? existing.all_day),
    location: String(b.location ?? existing.location ?? '').slice(0, 300),
    description: String(b.description ?? existing.description ?? '').slice(0, 20000),
    recurrence, recur_until: b.recur_until ? new Date(b.recur_until).toISOString() : existing.recur_until || null,
    attendees, online_url: String(b.online_url ?? existing.online_url ?? '').slice(0, 500),
    reminder_minutes: b.reminder_minutes === null || b.reminder_minutes === '' ? null : Number.isFinite(Number(b.reminder_minutes ?? existing.reminder_minutes)) ? Number(b.reminder_minutes ?? existing.reminder_minutes) : 15,
    show_as: ['busy', 'free', 'tentative', 'oof'].includes(b.show_as) ? b.show_as : existing.show_as || 'busy',
    color: String(b.color ?? existing.color ?? '').slice(0, 20),
  };
}

async function sendIcs(user, { method, event, to, replyFrom, subjectPrefix }) {
  if (!to.length) return;
  const ics = buildIcs({ method, events: [event], replyFrom });
  const when = event.all_day ? new Date(event.start_at).toUTCString().slice(0, 16) : new Date(event.start_at).toUTCString().replace(' GMT', ' UTC');
  const lines = [
    method === 'REPLY' ? `${user.name} has ${({ accepted: 'accepted', tentative: 'tentatively accepted', declined: 'declined' })[event.attendees.find((a) => a.email === replyFrom)?.status] || 'responded to'} this invitation.` : '',
    `When: ${when}`, event.location ? `Where: ${event.location}` : '', event.online_url ? `Join online: ${event.online_url}` : '',
    '', event.description || '',
  ].filter((l, i) => l || i > 3);
  await performSend(user, {
    to: to.join(', '),
    subject: `${subjectPrefix}${event.title}`,
    text: lines.join('\n'),
    noSignature: true,
    icalEvent: { method, filename: 'invite.ics', content: ics },
  });
}

export async function createEvent(user, body) {
  const e = cleanEvent(body);
  const uid = `${crypto.randomUUID()}@${config.primaryDomain}`;
  const r = db.prepare(`INSERT INTO events (user_id, uid, title, location, description, start_at, end_at, all_day, recurrence, recur_until,
      organizer_email, organizer_name, attendees_json, my_status, online_url, reminder_minutes, show_as, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'organizer', ?, ?, ?, ?)`)
    .run(user.id, uid, e.title, e.location, e.description, e.start_at, e.end_at, e.all_day ? 1 : 0, e.recurrence, e.recur_until,
      user.email, user.name, JSON.stringify(e.attendees), e.online_url, e.reminder_minutes, e.show_as, e.color);
  const ev = getEvent(user.id, r.lastInsertRowid);
  if (ev.attendees.length) await sendIcs(user, { method: 'REQUEST', event: ev, to: ev.attendees.map((a) => a.email), subjectPrefix: 'Invitation: ' });
  return ev;
}

export async function updateEvent(user, id, body) {
  const old = getEvent(user.id, id);
  if (!old) throw httpErr(404, 'Event not found.');
  const isOrganizer = old.my_status === 'organizer';
  // Attendees may only change their own reminder and colour
  const e = isOrganizer ? cleanEvent(body, old) : { ...old, reminder_minutes: body.reminder_minutes ?? old.reminder_minutes, color: body.color ?? old.color };
  const keepStatus = new Map(old.attendees.map((a) => [a.email, a.status]));
  const timeChanged = e.start_at !== old.start_at || e.end_at !== old.end_at;
  e.attendees = e.attendees.map((a) => ({ ...a, status: timeChanged ? 'needs-action' : keepStatus.get(a.email) || a.status }));
  const seq = isOrganizer ? old.sequence + 1 : old.sequence;
  db.prepare(`UPDATE events SET title = ?, location = ?, description = ?, start_at = ?, end_at = ?, all_day = ?, recurrence = ?, recur_until = ?,
      attendees_json = ?, online_url = ?, reminder_minutes = ?, show_as = ?, color = ?, sequence = ?, updated_at = datetime('now'), reminded_for = NULL WHERE id = ?`)
    .run(e.title, e.location, e.description, e.start_at, e.end_at, e.all_day ? 1 : 0, e.recurrence, e.recur_until, JSON.stringify(e.attendees),
      e.online_url, e.reminder_minutes, e.show_as, e.color, seq, old.id);
  const ev = getEvent(user.id, id);
  if (isOrganizer) {
    const removed = old.attendees.filter((a) => !ev.attendees.some((x) => x.email === a.email)).map((a) => a.email);
    if (ev.attendees.length) await sendIcs(user, { method: 'REQUEST', event: ev, to: ev.attendees.map((a) => a.email), subjectPrefix: 'Updated invitation: ' });
    if (removed.length) await sendIcs(user, { method: 'CANCEL', event: { ...ev, cancelled: true }, to: removed, subjectPrefix: 'Canceled: ' });
  }
  return ev;
}

export async function deleteEvent(user, id, { notify = true } = {}) {
  const ev = getEvent(user.id, id);
  if (!ev) throw httpErr(404, 'Event not found.');
  db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
  if (!notify) return;
  if (ev.my_status === 'organizer' && ev.attendees.length) {
    await sendIcs(user, { method: 'CANCEL', event: { ...ev, sequence: ev.sequence + 1, cancelled: true }, to: ev.attendees.map((a) => a.email), subjectPrefix: 'Canceled: ' });
  } else if (ev.my_status !== 'organizer' && ev.my_status !== 'declined' && ev.organizer_email) {
    const me = ev.attendees.find((a) => a.email === user.email) || { email: user.email, name: user.name };
    await sendIcs(user, { method: 'REPLY', event: { ...ev, attendees: [{ ...me, status: 'declined' }] }, to: [ev.organizer_email], replyFrom: user.email, subjectPrefix: 'Declined: ' });
  }
}

/** Accept / tentative / decline an invitation (by event id). */
export async function respond(user, id, status, { sendReply = true } = {}) {
  if (!['accepted', 'tentative', 'declined'].includes(status)) throw httpErr(400, 'Choose accept, tentative or decline.');
  const ev = getEvent(user.id, id);
  if (!ev) throw httpErr(404, 'Event not found.');
  if (ev.my_status === 'organizer') throw httpErr(400, 'You organized this meeting.');
  const attendees = ev.attendees.some((a) => a.email === user.email) ? ev.attendees.map((a) => (a.email === user.email ? { ...a, status } : a)) : [...ev.attendees, { email: user.email, name: user.name, status }];
  db.prepare("UPDATE events SET my_status = ?, attendees_json = ?, show_as = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, JSON.stringify(attendees), status === 'tentative' ? 'tentative' : status === 'declined' ? 'free' : 'busy', ev.id);
  const updated = getEvent(user.id, id);
  if (sendReply && ev.organizer_email) {
    await sendIcs(user, { method: 'REPLY', event: updated, to: [ev.organizer_email], replyFrom: user.email, subjectPrefix: `${({ accepted: 'Accepted', tentative: 'Tentative', declined: 'Declined' })[status]}: ` });
  }
  return updated;
}

/**
 * Process a calendar object that arrived by email for a local user.
 * REQUEST: add/update the event as "needs action". REPLY: update the attendee's status. CANCEL: mark cancelled.
 * Returns a summary stored on the message so the reader can show Accept/Decline buttons.
 */
export function handleInboundCalendar(userId, icsText, fromAddr) {
  const { method, events } = parseIcs(icsText);
  const e = events[0];
  if (!e?.uid || !e.start_at) return null;
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  const existing = db.prepare('SELECT * FROM events WHERE user_id = ? AND uid = ?').get(userId, e.uid);
  if (method === 'REQUEST') {
    if (existing && existing.my_status === 'organizer') return null; // our own invite echoed back
    if (existing && e.sequence < existing.sequence) return { method, uid: e.uid, eventId: existing.id, stale: true };
    const myStatus = existing && e.sequence === existing.sequence ? existing.my_status : 'needs-action';
    if (existing) {
      db.prepare(`UPDATE events SET title = ?, location = ?, description = ?, start_at = ?, end_at = ?, all_day = ?, recurrence = ?, recur_until = ?,
          organizer_email = ?, organizer_name = ?, attendees_json = ?, sequence = ?, online_url = ?, cancelled = 0, my_status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(e.title || '', e.location || '', e.description || '', e.start_at, e.end_at, e.all_day ? 1 : 0, e.recurrence, e.recur_until || null,
          e.organizer_email || fromAddr, e.organizer_name || '', JSON.stringify(e.attendees), e.sequence, e.online_url || '', myStatus, existing.id);
      return { method, uid: e.uid, eventId: existing.id, title: e.title, start_at: e.start_at, end_at: e.end_at, location: e.location, organizer: e.organizer_email };
    }
    const r = db.prepare(`INSERT INTO events (user_id, uid, title, location, description, start_at, end_at, all_day, recurrence, recur_until,
        organizer_email, organizer_name, attendees_json, my_status, sequence, online_url, reminder_minutes, show_as)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs-action', ?, ?, 15, 'tentative')`)
      .run(userId, e.uid, e.title || '', e.location || '', e.description || '', e.start_at, e.end_at, e.all_day ? 1 : 0, e.recurrence, e.recur_until || null,
        e.organizer_email || fromAddr, e.organizer_name || '', JSON.stringify(e.attendees), e.sequence, e.online_url || '');
    return { method, uid: e.uid, eventId: Number(r.lastInsertRowid), title: e.title, start_at: e.start_at, end_at: e.end_at, location: e.location, organizer: e.organizer_email };
  }
  if (method === 'REPLY' && existing && existing.my_status === 'organizer') {
    const reply = e.attendees[0];
    if (!reply) return null;
    const atts = JSON.parse(existing.attendees_json).map((a) => (a.email === reply.email ? { ...a, status: reply.status } : a));
    if (!atts.some((a) => a.email === reply.email)) atts.push(reply);
    db.prepare("UPDATE events SET attendees_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(atts), existing.id);
    return { method, uid: e.uid, eventId: existing.id, attendee: reply.email, status: reply.status, title: existing.title };
  }
  if (method === 'CANCEL' && existing && existing.my_status !== 'organizer') {
    db.prepare("UPDATE events SET cancelled = 1, updated_at = datetime('now') WHERE id = ?").run(existing.id);
    return { method, uid: e.uid, eventId: existing.id, title: existing.title, start_at: existing.start_at };
  }
  void user;
  return null;
}

/** Busy times for colleagues (same organization) or yourself: the scheduling assistant. */
export function freeBusy(viewer, emails, from, to) {
  const out = {};
  for (const raw of emails.slice(0, 50)) {
    const email = String(raw).trim().toLowerCase();
    const u = db.prepare('SELECT id, org_id FROM users WHERE email = ?').get(email);
    const allowed = u && (u.id === viewer.id || (viewer.org_kind === 'private' && u.org_id === viewer.org_id));
    out[email] = allowed ? listEvents(u.id, from, to).filter((e) => e.show_as !== 'free' && e.my_status !== 'declined')
      .map((e) => ({ start: e.start_at, end: e.end_at, status: e.show_as })) : null;
  }
  return out;
}

export function feedIcs(userId) {
  const events = db.prepare('SELECT * FROM events WHERE user_id = ? AND cancelled = 0').all(userId).map(row2event);
  return buildIcs({ method: 'PUBLISH', events });
}

export function importIcs(user, text) {
  const { events } = parseIcs(text);
  let n = 0;
  for (const e of events) {
    if (!e.start_at) continue;
    const uid = e.uid || `${crypto.randomUUID()}@import`;
    const r = db.prepare(`INSERT OR IGNORE INTO events (user_id, uid, title, location, description, start_at, end_at, all_day, recurrence, recur_until,
        organizer_email, organizer_name, attendees_json, my_status, sequence, online_url, show_as)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.id, uid, e.title || '', e.location || '', e.description || '', e.start_at, e.end_at, e.all_day ? 1 : 0, e.recurrence, e.recur_until || null,
        e.organizer_email || '', e.organizer_name || '', JSON.stringify(e.attendees || []),
        !e.organizer_email || e.organizer_email === user.email ? 'organizer' : 'accepted', e.sequence || 0, e.online_url || '', e.show_as || 'busy');
    n += r.changes;
  }
  return n;
}

// ------------------------------------------------------------ reminders (events and tasks)
export function notify(userId, kind, title, body = '', link = {}) {
  db.prepare('INSERT INTO notifications (user_id, kind, title, body, link_json) VALUES (?, ?, ?, ?, ?)').run(userId, kind, title, body, JSON.stringify(link));
}

export function processReminders(now = new Date()) {
  const horizon = new Date(now.getTime() + 24 * 3600e3).toISOString();
  const candidates = db.prepare(`SELECT * FROM events WHERE cancelled = 0 AND reminder_minutes IS NOT NULL AND my_status != 'declined'
    AND ((recurrence = 'none' AND start_at > ? AND start_at < ?) OR (recurrence != 'none' AND start_at < ?))`)
    .all(new Date(now.getTime() - 3600e3).toISOString(), horizon, horizon);
  for (const r of candidates) {
    const ev = row2event(r);
    for (const occ of occurrences(ev, now.toISOString(), horizon)) {
      const due = new Date(new Date(occ.start_at).getTime() - ev.reminder_minutes * 60e3);
      if (due <= now && r.reminded_for !== occ.start_at) {
        notify(r.user_id, 'event', `${ev.title}`, `Starts ${occ.start_at}${ev.location ? ` · ${ev.location}` : ''}`, { eventId: ev.id, start: occ.start_at });
        db.prepare('UPDATE events SET reminded_for = ? WHERE id = ?').run(occ.start_at, ev.id);
        break;
      }
    }
  }
  for (const t of db.prepare('SELECT * FROM tasks WHERE reminded = 0 AND completed_at IS NULL AND reminder_at IS NOT NULL AND reminder_at <= ?').all(now.toISOString())) {
    notify(t.user_id, 'task', t.title, t.due_at ? `Due ${t.due_at}` : '', { taskId: t.id });
    db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').run(t.id);
  }
}
