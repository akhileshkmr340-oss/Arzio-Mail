// Minimal iCalendar (RFC 5545) writer and reader for meeting invites,
// replies, cancellations, feeds and .ics import.

const RRULE = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };
const RRULE_REV = Object.fromEntries(Object.entries(RRULE).map(([k, v]) => [v, k]));

function escText(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function unescText(s) {
  return String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 74) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}
function fmtUtc(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function fmtDate(iso) {
  return new Date(iso).toISOString().slice(0, 10).replace(/-/g, '');
}
const PARTSTAT = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED', 'needs-action': 'NEEDS-ACTION' };

/**
 * Build a VCALENDAR. method: REQUEST | REPLY | CANCEL | PUBLISH (feeds).
 * events: [{ uid, title, description, location, start_at, end_at, all_day, recurrence, recur_until,
 *            organizer_email, organizer_name, attendees:[{email,name,status}], sequence, online_url, cancelled }]
 * replyFrom: for REPLY, only this attendee is included.
 */
export function buildIcs({ method = 'REQUEST', events, prodId = '-//Arzio Mail//Calendar//EN', replyFrom }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN', ...(method ? [`METHOD:${method}`] : [])];
  for (const e of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.uid}`);
    lines.push(`DTSTAMP:${fmtUtc(new Date().toISOString())}`);
    lines.push(`SEQUENCE:${e.sequence || 0}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDate(e.start_at)}`);
      lines.push(`DTEND;VALUE=DATE:${fmtDate(e.end_at)}`);
    } else {
      lines.push(`DTSTART:${fmtUtc(e.start_at)}`);
      lines.push(`DTEND:${fmtUtc(e.end_at)}`);
    }
    if (e.recurrence && RRULE[e.recurrence]) lines.push(`RRULE:FREQ=${RRULE[e.recurrence]}${e.recur_until ? `;UNTIL=${fmtUtc(e.recur_until)}` : ''}`);
    lines.push(`SUMMARY:${escText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escText(e.location)}`);
    const desc = [e.description, e.online_url ? `Join online: ${e.online_url}` : ''].filter(Boolean).join('\n\n');
    if (desc) lines.push(`DESCRIPTION:${escText(desc)}`);
    if (e.online_url) lines.push(`URL:${e.online_url}`);
    if (e.organizer_email) lines.push(`ORGANIZER;CN=${escText(e.organizer_name || e.organizer_email)}:mailto:${e.organizer_email}`);
    const atts = replyFrom ? (e.attendees || []).filter((a) => a.email === replyFrom) : e.attendees || [];
    for (const a of atts) {
      lines.push(`ATTENDEE;CN=${escText(a.name || a.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=${PARTSTAT[a.status] || 'NEEDS-ACTION'};RSVP=TRUE:mailto:${a.email}`);
    }
    lines.push(`STATUS:${method === 'CANCEL' || e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`);
    lines.push(`TRANSP:${e.show_as === 'free' ? 'TRANSPARENT' : 'OPAQUE'}`);
    if (!method && Number.isFinite(e.reminder_minutes) && e.reminder_minutes !== null) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escText(e.title)}`, `TRIGGER:-PT${e.reminder_minutes}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function parseDate(value, params) {
  const v = String(value).trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    return { iso: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00.000Z`, allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return { iso: new Date(v).toISOString(), allDay: false };
  const [, y, mo, d, h, mi, se, z] = m;
  // Floating or TZID times are treated as UTC unless the TZID is an offset we can't resolve; good enough for invites
  const iso = z ? `${y}-${mo}-${d}T${h}:${mi}:${se}.000Z` : tzToUtc(`${y}-${mo}-${d}T${h}:${mi}:${se}`, params.TZID);
  return { iso, allDay: false };
}

// Convert a wall-clock time in an IANA zone to UTC using Intl
function tzToUtc(local, tz) {
  const asUtc = new Date(local + 'Z');
  if (!tz) return asUtc.toISOString();
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = Object.fromEntries(fmt.formatToParts(asUtc).map((p) => [p.type, p.value]));
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return new Date(asUtc.getTime() - (shown - asUtc.getTime())).toISOString();
  } catch {
    return asUtc.toISOString();
  }
}

/** Parse an .ics document into { method, events: [...] } */
export function parseIcs(text) {
  const raw = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  let method = 'PUBLISH';
  const events = [];
  let cur = null;
  let depth = 0;
  for (const line of raw) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = left.split(';');
    const params = Object.fromEntries(paramParts.map((p) => { const i = p.indexOf('='); return [p.slice(0, i).toUpperCase(), p.slice(i + 1).replace(/^"|"$/g, '')]; }));
    const key = name.toUpperCase();
    if (key === 'BEGIN' && value.toUpperCase() === 'VEVENT') { cur = { attendees: [], sequence: 0, recurrence: 'none' }; depth = 0; continue; }
    if (!cur) { if (key === 'METHOD') method = value.trim().toUpperCase(); continue; }
    if (key === 'BEGIN') { depth++; continue; } // nested VALARM etc.
    if (key === 'END' && value.toUpperCase() === 'VEVENT') { events.push(cur); cur = null; continue; }
    if (key === 'END') { depth--; continue; }
    if (depth > 0) {
      // First alarm becomes the event reminder
      const t = key === 'TRIGGER' && cur.reminder_minutes === undefined && value.trim().match(/^-P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
      if (t) cur.reminder_minutes = (+t[1] || 0) * 1440 + (+t[2] || 0) * 60 + (+t[3] || 0);
      continue;
    }
    switch (key) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.title = unescText(value); break;
      case 'DESCRIPTION': cur.description = unescText(value); break;
      case 'LOCATION': cur.location = unescText(value); break;
      case 'URL': cur.online_url = value.trim(); break;
      case 'SEQUENCE': cur.sequence = Number(value) || 0; break;
      case 'STATUS': cur.cancelled = value.trim().toUpperCase() === 'CANCELLED'; break;
      case 'TRANSP': cur.show_as = value.trim().toUpperCase() === 'TRANSPARENT' ? 'free' : 'busy'; break;
      case 'DTSTART': { const d = parseDate(value, params); cur.start_at = d.iso; cur.all_day = d.allDay; break; }
      case 'DTEND': cur.end_at = parseDate(value, params).iso; break;
      case 'DURATION': cur.duration = value.trim(); break;
      case 'RRULE': {
        const r = Object.fromEntries(value.split(';').map((p) => p.split('=')));
        cur.recurrence = RRULE_REV[r.FREQ] || 'none';
        if (r.UNTIL) cur.recur_until = parseDate(r.UNTIL, {}).iso;
        break;
      }
      case 'ORGANIZER': cur.organizer_email = value.replace(/^mailto:/i, '').trim().toLowerCase(); cur.organizer_name = unescText(params.CN || ''); break;
      case 'ATTENDEE':
        cur.attendees.push({ email: value.replace(/^mailto:/i, '').trim().toLowerCase(), name: unescText(params.CN || ''), status: String(params.PARTSTAT || 'NEEDS-ACTION').toLowerCase() });
        break;
      default:
    }
  }
  for (const e of events) {
    if (!e.end_at && e.start_at) {
      const dur = e.duration?.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
      const ms = dur ? ((+dur[1] || 0) * 86400 + (+dur[2] || 0) * 3600 + (+dur[3] || 0) * 60) * 1000 : (e.all_day ? 86400e3 : 3600e3);
      e.end_at = new Date(new Date(e.start_at).getTime() + ms).toISOString();
    }
    delete e.duration;
  }
  return { method, events };
}
