// IMAP4rev1 server so desktop and phone mail apps (Outlook, Apple Mail,
// Thunderbird, Gmail app, K-9...) can use Arzio mailboxes.
// Supports: LOGIN / AUTHENTICATE PLAIN (account or app password), LIST/LSUB with
// SPECIAL-USE, STATUS, SELECT/EXAMINE, FETCH (ENVELOPE, BODYSTRUCTURE, BODY[...]),
// STORE, SEARCH, COPY, MOVE, APPEND, EXPUNGE, IDLE, UIDPLUS, NAMESPACE, ID.
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { storageLimit } from '../billing.js';
import * as blobs from '../blobs.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { clientLogin } from '../auth.js';
import * as store from './store.js';
import { audit } from '../audit.js';

const MAX_LINE = 64 * 1024;
const CAPS_PRE = 'IMAP4rev1 LITERAL+ SASL-IR AUTH=PLAIN ID ENABLE';
const CAPS = 'IMAP4rev1 LITERAL+ SASL-IR ID IDLE NAMESPACE UIDPLUS MOVE SPECIAL-USE UNSELECT ENABLE CHILDREN';
const ROLE_ATTR = { drafts: '\\Drafts', sent: '\\Sent', archive: '\\Archive', junk: '\\Junk', trash: '\\Trash' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ------------------------------------------------------------ helpers: strings, dates, names

function q(s) {
  if (s === null || s === undefined) return 'NIL';
  s = String(s);
  if (/^[\x20-\x7e]*$/.test(s)) return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return `{${Buffer.byteLength(s)}}\r\n${s}`;
}
const nstr = (s) => (s === null || s === undefined || s === '' ? 'NIL' : q(s));

function imapDate(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getUTCDate())}-${MONTHS[x.getUTCMonth()]}-${x.getUTCFullYear()} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())} +0000`;
}
function parseSearchDate(s) {
  const m = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const mo = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  return mo < 0 ? null : Date.UTC(Number(m[3]), mo, Number(m[1]));
}
const dayOf = (d) => { const x = new Date(d); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); };

// Modified UTF-7 (RFC 3501 5.1.3) for mailbox names
function encodeMailbox(s) {
  return s.replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, (chunk) => {
    const b = Buffer.alloc(chunk.length * 2);
    for (let i = 0; i < chunk.length; i++) b.writeUInt16BE(chunk.charCodeAt(i), i * 2);
    return `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
  });
}
function decodeMailbox(s) {
  return String(s).replace(/&([^-]*)-/g, (_, b64) => {
    if (!b64) return '&';
    const b = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode(b.readUInt16BE(i));
    return out;
  });
}

// ------------------------------------------------------------ command tokenizer

function tokenize(s, lits) {
  let i = 0;
  function list(end) {
    const out = [];
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ') { i++; continue; }
      if (ch === end) { i++; return out; }
      if (ch === '(') { i++; out.push(list(')')); continue; }
      if (ch === '"') {
        i++;
        let v = '';
        while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; v += s[i++]; }
        i++;
        out.push({ str: v });
        continue;
      }
      if (ch === '\x00') {
        const j = s.indexOf('\x00', i + 1);
        out.push({ str: lits[Number(s.slice(i + 1, j))], lit: true });
        i = j + 1;
        continue;
      }
      let v = '';
      while (i < s.length && !' ()'.includes(s[i])) {
        if (s[i] === '[') {
          const j = s.indexOf(']', i);
          if (j < 0) { v += s.slice(i); i = s.length; break; }
          v += s.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        v += s[i++];
      }
      out.push(v);
    }
    return out;
  }
  return list(null);
}
const text = (t) => (t === undefined || t === null ? '' : typeof t === 'string' ? t : Buffer.isBuffer(t.str) ? t.str.toString('utf8') : String(t.str ?? ''));

// ------------------------------------------------------------ MIME parsing (for BODYSTRUCTURE and sections)

function parseParams(v) {
  const parts = [];
  let cur = '';
  let inQ = false;
  for (const ch of String(v || '')) {
    if (ch === '"') inQ = !inQ;
    if (ch === ';' && !inQ) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  const value = parts.shift().trim();
  const params = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0) params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"([\s\S]*)"$/, '$1');
  }
  return { value, params };
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseNode(buf, depth = 0, defType = 'text/plain') {
  const s = buf.toString('latin1');
  let hEnd;
  let bStart;
  if (s.startsWith('\r\n')) { hEnd = 2; bStart = 2; } else if (s.startsWith('\n')) { hEnd = 1; bStart = 1; } else {
    const m = s.match(/\r?\n\r?\n/);
    if (m) { hEnd = m.index + m[0].length; bStart = hEnd; } else { hEnd = s.length; bStart = s.length; }
  }
  const headerRaw = buf.subarray(0, hEnd);
  const body = buf.subarray(bStart);
  const headers = [];
  for (const line of headerRaw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
  }
  const h = (n) => headers.find(([k]) => k === n)?.[1];
  const ct = parseParams(h('content-type') || defType);
  const [type, sub] = (ct.value.includes('/') ? ct.value : defType).toLowerCase().split('/');
  const node = { headerRaw, body, headers, h, type, sub, params: ct.params };
  if (type === 'multipart' && ct.params.boundary && depth < 20) {
    const bs = body.toString('latin1');
    const re = new RegExp(`(^|\\r?\\n)--${escRe(ct.params.boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
    node.parts = [];
    let last = null;
    let m;
    while ((m = re.exec(bs))) {
      if (last !== null) node.parts.push(parseNode(body.subarray(last, m.index), depth + 1, sub === 'digest' ? 'message/rfc822' : 'text/plain'));
      if (m[2]) { last = null; break; }
      let end = m.index + m[0].length;
      if (bs[end] === '\r') end++;
      if (bs[end] === '\n') end++;
      last = end;
    }
    if (last !== null) node.parts.push(parseNode(body.subarray(last), depth + 1));
    if (!node.parts.length) node.parts.push(parseNode(Buffer.from('\r\n'), depth + 1));
  } else if (type === 'message' && sub === 'rfc822' && depth < 20) {
    node.message = parseNode(body, depth + 1);
  }
  return node;
}

function addrs(v) {
  if (!v) return 'NIL';
  const list = addressparser(v).flatMap((a) => (a.group ? a.group : [a])).filter((a) => a.address || a.name);
  if (!list.length) return 'NIL';
  return `(${list.map((a) => {
    const [mb, host] = String(a.address || '').split('@');
    return `(${nstr(a.name)} NIL ${nstr(mb)} ${nstr(host)})`;
  }).join('')})`;
}

function envelope(n) {
  const from = n.h('from');
  return `(${nstr(n.h('date'))} ${nstr(n.h('subject'))} ${addrs(from)} ${addrs(n.h('sender') || from)} ${addrs(n.h('reply-to') || from)} ${addrs(n.h('to'))} ${addrs(n.h('cc'))} ${addrs(n.h('bcc'))} ${nstr(n.h('in-reply-to'))} ${nstr(n.h('message-id'))})`;
}

const paramList = (p) => {
  const e = Object.entries(p || {});
  return e.length ? `(${e.map(([k, v]) => `${q(k.toUpperCase())} ${q(v)}`).join(' ')})` : 'NIL';
};
function disposition(n) {
  const d = n.h('content-disposition');
  if (!d) return 'NIL';
  const p = parseParams(d);
  return `(${q(p.value.toUpperCase())} ${paramList(p.params)})`;
}
const lineCount = (b) => { let c = 0; for (const x of b) if (x === 10) c++; return c; };

function bodyStructure(n, ext) {
  if (n.parts) {
    const extra = ext ? ` ${paramList({ boundary: n.params.boundary })} ${disposition(n)} NIL NIL` : '';
    return `(${n.parts.map((p) => bodyStructure(p, ext)).join('')} ${q(n.sub.toUpperCase())}${extra})`;
  }
  const f = [q(n.type.toUpperCase()), q(n.sub.toUpperCase()), paramList(n.params), nstr(n.h('content-id')), nstr(n.h('content-description')),
    q((n.h('content-transfer-encoding') || '7BIT').toUpperCase()), String(n.body.length)];
  if (n.type === 'text') f.push(String(lineCount(n.body)));
  if (n.message) f.push(envelope(n.message), bodyStructure(n.message, ext), String(lineCount(n.body)));
  if (ext) f.push('NIL', disposition(n), 'NIL', 'NIL');
  return `(${f.join(' ')})`;
}

function headerFields(n, names, not) {
  const want = new Set(names.map((x) => x.toLowerCase()));
  const out = [];
  const lines = n.headerRaw.toString('latin1').split(/\r?\n(?![ \t])/);
  for (const l of lines) {
    if (!l) continue;
    const name = l.slice(0, l.indexOf(':')).trim().toLowerCase();
    if (want.has(name) !== !!not) out.push(l.replace(/\r?\n/g, '\r\n'));
  }
  return Buffer.from(out.join('\r\n') + (out.length ? '\r\n' : '') + '\r\n', 'latin1');
}

/** Content of BODY[section] for one message. */
function section(raw, root, sec) {
  const m = sec.match(/^((?:\d+\.)*\d+)?\.?(HEADER\.FIELDS\.NOT|HEADER\.FIELDS|HEADER|TEXT|MIME)?\s*(?:\((.*)\))?$/i);
  if (!m) return null;
  const path = m[1] ? m[1].split('.').map(Number) : [];
  const spec = (m[2] || '').toUpperCase();
  let cur = root;
  for (const num of path) {
    const container = cur.message || cur;
    if (container.parts) cur = container.parts[num - 1];
    else if (num === 1) cur = container;
    else return Buffer.alloc(0);
    if (!cur) return Buffer.alloc(0);
  }
  if (!spec) return path.length ? cur.body : raw;
  if (spec === 'MIME') return cur.headerRaw;
  const msg = path.length ? cur.message : root;
  if (!msg) return Buffer.alloc(0);
  if (spec === 'HEADER') return msg.headerRaw;
  if (spec === 'TEXT') return msg.body;
  const names = (m[3] || '').split(/\s+/).filter(Boolean).map((x) => x.replace(/"/g, ''));
  return headerFields(msg, names, spec === 'HEADER.FIELDS.NOT');
}

// ------------------------------------------------------------ mailbox access

function flagsOf(r, role) {
  const f = [];
  if (r.is_read) f.push('\\Seen');
  if (r.is_answered) f.push('\\Answered');
  if (r.is_flagged) f.push('\\Flagged');
  if (r.imap_deleted) f.push('\\Deleted');
  if (r.is_draft || role === 'drafts') f.push('\\Draft');
  return f.join(' ');
}

function folderForName(userId, name) {
  const n = decodeMailbox(name);
  if (n.toUpperCase() === 'INBOX') return store.folderByRole(userId, 'inbox');
  return db.prepare('SELECT * FROM folders WHERE user_id = ? AND name = ? AND (role IS NULL OR role NOT IN (?, ?))').get(userId, n, 'inbox', 'recoverable');
}
const nameOf = (f) => (f.role === 'inbox' ? 'INBOX' : encodeMailbox(f.name));

async function rawOf(m) {
  const stored = m.raw_path ? blobs.get(m.raw_path) : null;
  if (stored) return stored;
  // Messages without stored MIME (drafts written in the web app, system notices): build it once
  const atts = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(m.id);
  const raw = await new MailComposer({
    from: m.from_addr ? { name: m.from_name, address: m.from_addr } : undefined,
    to: JSON.parse(m.to_json || '[]'), cc: JSON.parse(m.cc_json || '[]'),
    subject: m.subject, text: m.text_body, html: m.html_body || undefined,
    date: new Date(m.date), messageId: m.message_id || undefined, inReplyTo: m.in_reply_to || undefined, references: m.refs || undefined,
    attachments: atts.map((a) => ({ filename: a.filename, contentType: a.content_type, content: blobs.get(a.storage_path) || Buffer.alloc(0), cid: a.content_id || undefined })),
  }).compile().build();
  store.saveRaw(m.id, raw);
  return raw;
}

// ------------------------------------------------------------ sessions

const failures = new Map(); // ip -> [timestamps]
function tooManyFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  failures.set(ip, list);
  return list.length >= 10;
}

class Session {
  constructor(socket, secure) {
    this.socket = socket;
    this.secure = secure;
    this.ip = socket.remoteAddress;
    this.user = null;
    this.box = null;
    this.readOnly = false;
    this.uids = [];
    this.flags = new Map();
    this.buf = Buffer.alloc(0);
    this.cmd = null;
    this.need = 0;
    this.continuation = null;
    this.queue = Promise.resolve();
    this.closed = false;
    socket.setTimeout(30 * 60e3, () => this.close('* BYE Idle timeout'));
    socket.on('data', (c) => this.onData(c));
    socket.on('error', () => {});
    socket.on('close', () => { this.closed = true; clearInterval(this.idleTimer); });
    this.send(`* OK [CAPABILITY ${CAPS_PRE}] ${config.serviceName} IMAP ready`);
  }

  send(...parts) {
    if (this.closed) return;
    const bufs = parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8')));
    bufs.push(Buffer.from('\r\n'));
    this.socket.write(Buffer.concat(bufs));
  }

  close(msg) {
    if (msg) this.send(msg);
    this.closed = true;
    this.socket.end();
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const literalMax = config.quotas.maxMessageBytes + 1024 * 1024;
    while (!this.closed) {
      if (this.need > 0) {
        if (this.buf.length < this.need) return;
        this.cmd.lits.push(this.buf.subarray(0, this.need));
        this.cmd.text += `\x00${this.cmd.lits.length - 1}\x00`;
        this.buf = this.buf.subarray(this.need);
        this.need = 0;
        continue;
      }
      const nl = this.buf.indexOf(10);
      if (nl < 0) {
        if (this.buf.length > MAX_LINE) this.close('* BYE Line too long');
        return;
      }
      const line = this.buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.subarray(nl + 1);
      if (this.continuation) { const fn = this.continuation; this.continuation = null; fn(line); continue; }
      this.cmd = this.cmd || { text: '', lits: [] };
      const m = line.match(/\{(\d+)(\+?)\}$/);
      if (m) {
        const n = Number(m[1]);
        this.cmd.text += line.slice(0, -m[0].length);
        if (n > literalMax) { this.close('* BYE Message too large'); return; }
        if (n === 0) { this.cmd.lits.push(Buffer.alloc(0)); this.cmd.text += `\x00${this.cmd.lits.length - 1}\x00`; continue; }
        this.need = n;
        if (!m[2]) this.send('+ Ready for literal data');
        continue;
      }
      this.cmd.text += line;
      if (this.cmd.text.length > MAX_LINE * 4) { this.close('* BYE Command too long'); return; }
      const c = this.cmd;
      this.cmd = null;
      this.queue = this.queue.then(() => this.run(c)).catch((e) => console.error('[imap]', e));
    }
  }

  async run({ text: line, lits }) {
    if (this.closed || !line.trim()) return;
    const toks = tokenize(line, lits);
    const tag = typeof toks[0] === 'string' ? toks[0] : '*';
    let name = String(toks[1] || '').toUpperCase();
    let args = toks.slice(2);
    let uid = false;
    if (name === 'UID') { uid = true; name = String(args[0] || '').toUpperCase(); args = args.slice(1); }
    try {
      const fn = COMMANDS[name];
      if (!fn) return this.send(`${tag} BAD Unknown command`);
      const needs = STATES[name] || 'any';
      if (needs === 'auth' && !this.user) return this.send(`${tag} NO Sign in first`);
      if (needs === 'selected' && !this.box) return this.send(`${tag} NO Select a mailbox first`);
      const res = await fn.call(this, args, { tag, uid });
      if (res !== false) this.send(`${tag} OK ${typeof res === 'string' ? res : `${uid ? 'UID ' : ''}${name} completed`}`);
    } catch (e) {
      if (e.imap) this.send(`${tag} ${e.imap} ${e.message}`);
      else { console.error('[imap] command failed', e); this.send(`${tag} NO Server error, try again`); }
    }
  }

  // ---- selected-mailbox state
  rows(cols = 'id, imap_uid, is_read, is_flagged, is_answered, imap_deleted, is_draft') {
    return db.prepare(`SELECT ${cols} FROM messages WHERE folder_id = ? AND user_id = ? ORDER BY imap_uid`).all(this.box.id, this.user.id);
  }

  /** Report new, removed and changed messages since the client last looked. */
  sync({ expunge = true } = {}) {
    if (!this.box) return;
    const rows = this.rows();
    if (expunge) {
      const present = new Set(rows.map((r) => r.imap_uid));
      for (let i = this.uids.length - 1; i >= 0; i--) {
        if (!present.has(this.uids[i])) { this.send(`* ${i + 1} EXPUNGE`); this.flags.delete(this.uids[i]); this.uids.splice(i, 1); }
      }
    }
    const max = this.uids.at(-1) || 0;
    const added = rows.filter((r) => r.imap_uid > max);
    if (added.length) {
      this.uids.push(...added.map((r) => r.imap_uid));
      this.send(`* ${this.uids.length} EXISTS`);
    }
    const index = new Map(this.uids.map((u, i) => [u, i + 1]));
    for (const r of rows) {
      const f = flagsOf(r, this.box.role);
      const old = this.flags.get(r.imap_uid);
      if (old !== undefined && old !== f && index.has(r.imap_uid)) this.send(`* ${index.get(r.imap_uid)} FETCH (UID ${r.imap_uid} FLAGS (${f}))`);
      this.flags.set(r.imap_uid, f);
    }
  }

  /** Resolve a sequence set (or UID set) to [{seq, uid}] in the selected mailbox. */
  resolve(set, uid) {
    const out = [];
    const max = uid ? this.uids.at(-1) || 0 : this.uids.length;
    const ranges = String(set).split(',').map((r) => {
      const [a, b = a] = r.split(':');
      const x = a === '*' ? max : Number(a);
      const y = b === '*' ? max : Number(b);
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw Object.assign(new Error('Invalid sequence set'), { imap: 'BAD' });
      return [Math.min(x, y), Math.max(x, y)];
    });
    const inSet = (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
    this.uids.forEach((u, i) => { if (inSet(uid ? u : i + 1)) out.push({ seq: i + 1, uid: u }); });
    return out;
  }

  message(uidN) {
    return db.prepare('SELECT * FROM messages WHERE folder_id = ? AND user_id = ? AND imap_uid = ?').get(this.box.id, this.user.id, uidN);
  }

  selectBox(f, readOnly) {
    this.box = f;
    this.readOnly = readOnly;
    const rows = this.rows();
    this.uids = rows.map((r) => r.imap_uid);
    this.flags = new Map(rows.map((r) => [r.imap_uid, flagsOf(r, f.role)]));
    const unseen = rows.findIndex((r) => !r.is_read);
    const uidNext = db.prepare('SELECT uid_next FROM folders WHERE id = ?').get(f.id).uid_next;
    this.send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
    this.send(`* OK [PERMANENTFLAGS (${readOnly ? '' : '\\Answered \\Flagged \\Deleted \\Seen \\Draft'})] Flags permitted`);
    this.send(`* ${rows.length} EXISTS`);
    this.send('* 0 RECENT');
    if (unseen >= 0) this.send(`* OK [UNSEEN ${unseen + 1}] First unseen`);
    this.send(`* OK [UIDVALIDITY ${f.id}] UIDs valid`);
    this.send(`* OK [UIDNEXT ${uidNext}] Predicted next UID`);
  }
}

const err = (kind, msg) => Object.assign(new Error(msg), { imap: kind });

const STATES = {
  SELECT: 'auth', EXAMINE: 'auth', CREATE: 'auth', DELETE: 'auth', RENAME: 'auth', SUBSCRIBE: 'auth', UNSUBSCRIBE: 'auth',
  LIST: 'auth', LSUB: 'auth', STATUS: 'auth', APPEND: 'auth', NAMESPACE: 'auth', IDLE: 'auth', ENABLE: 'auth',
  CHECK: 'selected', CLOSE: 'selected', UNSELECT: 'selected', EXPUNGE: 'selected', SEARCH: 'selected', FETCH: 'selected',
  STORE: 'selected', COPY: 'selected', MOVE: 'selected',
};

function setFlags(userId, id, flags, mode) {
  const map = { '\\SEEN': 'is_read', '\\FLAGGED': 'is_flagged', '\\ANSWERED': 'is_answered', '\\DELETED': 'imap_deleted', '\\DRAFT': 'is_draft' };
  const given = new Set(flags.map((f) => text(f).toUpperCase()));
  const sets = [];
  for (const [flag, col] of Object.entries(map)) {
    if (mode === 'set') sets.push(`${col} = ${given.has(flag) ? 1 : 0}`);
    else if (given.has(flag)) sets.push(`${col} = ${mode === 'add' ? 1 : 0}`);
  }
  if (sets.length) db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(id, userId);
}

function listMatch(pattern, name) {
  const re = new RegExp(`^${pattern.split('').map((c) => (c === '*' ? '.*' : c === '%' ? '[^/]*' : escRe(c))).join('')}$`, 'i');
  return re.test(name);
}

const COMMANDS = {
  CAPABILITY() { this.send(`* CAPABILITY ${this.user ? CAPS : CAPS_PRE}`); },
  NOOP() { this.sync(); },
  CHECK() { this.sync(); },
  LOGOUT() { this.send('* BYE Signing out'); this.send(`${arguments[1].tag} OK LOGOUT completed`); this.close(); return false; },
  ID() { this.send(`* ID ("name" "${config.serviceName}" "vendor" "Arzio")`); },
  ENABLE() { this.send('* ENABLED'); },

  async LOGIN(args) {
    if (this.user) throw err('BAD', 'Already signed in');
    return this.authenticate(text(args[0]), text(args[1]));
  },

  async AUTHENTICATE(args, { tag }) {
    if (this.user) throw err('BAD', 'Already signed in');
    if (text(args[0]).toUpperCase() !== 'PLAIN') throw err('NO', 'Only PLAIN is supported');
    let b64 = args[1] ? text(args[1]) : null;
    if (!b64) {
      this.send('+ ');
      b64 = await new Promise((resolve) => { this.continuation = resolve; });
    }
    if (b64 === '*') throw err('BAD', 'Authentication cancelled');
    const [, user, pass] = Buffer.from(b64, 'base64').toString('utf8').split('\x00');
    return this.authenticate(user, pass, tag);
  },

  async SELECT(args) { return this.openBox(args, false); },
  async EXAMINE(args) { return this.openBox(args, true); },

  NAMESPACE() { this.send('* NAMESPACE (("" "/")) NIL NIL'); },

  LIST(args) { return this.list(args, 'LIST'); },
  LSUB(args) { return this.list(args, 'LSUB'); },

  STATUS(args) {
    const f = folderForName(this.user.id, text(args[0]));
    if (!f) throw err('NO', '[NONEXISTENT] No such mailbox');
    const items = (Array.isArray(args[1]) ? args[1] : [args[1]]).map((x) => text(x).toUpperCase());
    const c = db.prepare('SELECT COUNT(*) AS n, SUM(is_read = 0) AS unseen FROM messages WHERE folder_id = ?').get(f.id);
    const uidNext = db.prepare('SELECT uid_next FROM folders WHERE id = ?').get(f.id).uid_next;
    const vals = { MESSAGES: c.n, RECENT: 0, UIDNEXT: uidNext, UIDVALIDITY: f.id, UNSEEN: c.unseen || 0 };
    this.send(`* STATUS ${q(nameOf(f))} (${items.filter((k) => k in vals).map((k) => `${k} ${vals[k]}`).join(' ')})`);
  },

  CREATE(args) {
    const name = decodeMailbox(text(args[0])).replace(/\/$/, '');
    if (name.toUpperCase() === 'INBOX') throw err('NO', '[ALREADYEXISTS] Mailbox exists');
    try { store.createFolder(this.user.id, name); } catch (e) { throw err('NO', `[ALREADYEXISTS] ${e.message}`); }
  },
  DELETE(args) {
    const f = folderForName(this.user.id, text(args[0]));
    if (!f) throw err('NO', '[NONEXISTENT] No such mailbox');
    if (f.role) throw err('NO', 'System folders cannot be deleted');
    store.deleteFolder(this.user.id, f.id);
  },
  RENAME(args) {
    const f = folderForName(this.user.id, text(args[0]));
    if (!f) throw err('NO', '[NONEXISTENT] No such mailbox');
    if (f.role) throw err('NO', 'System folders cannot be renamed');
    store.renameFolder(this.user.id, f.id, decodeMailbox(text(args[1])));
  },
  SUBSCRIBE() {},
  UNSUBSCRIBE() {},

  async APPEND(args) {
    const f = folderForName(this.user.id, text(args[0]));
    if (!f) throw err('NO', '[TRYCREATE] No such mailbox');
    let i = 1;
    const flags = Array.isArray(args[i]) ? args[i++] : [];
    let date = null;
    if (args[i] && typeof args[i] === 'object' && !args[i].lit && !Array.isArray(args[i])) date = new Date(text(args[i++]).replace(/^(\d{1,2})-(\w{3})-(\d{4})/, '$2 $1 $3'));
    const lit = args[i];
    if (!lit?.lit) throw err('BAD', 'Message literal missing');
    const raw = lit.str;
    if (store.mailboxUsage(this.user.id) + raw.length > storageLimit(this.user.id)) throw err('NO', '[OVERQUOTA] Mailbox is full');
    const parsed = await simpleParser(raw);
    const list = (v) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x) => x.value || []) : []).map((a) => ({ address: String(a.address || '').toLowerCase(), name: a.name || '' })).filter((a) => a.address);
    const id = store.storeMessage(this.user.id, {
      folderId: f.id, messageId: parsed.messageId || null, inReplyTo: parsed.inReplyTo || null,
      refs: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || null,
      from: list(parsed.from)[0] || { address: '', name: '' }, to: list(parsed.to), cc: list(parsed.cc), bcc: list(parsed.bcc),
      subject: parsed.subject || '', text: parsed.text || '', html: typeof parsed.html === 'string' ? parsed.html : '',
      date: parsed.date || (date && !Number.isNaN(date.getTime()) ? date : new Date()), size: raw.length, raw,
      attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content, contentId: a.contentId })),
    });
    setFlags(this.user.id, id, flags, 'set');
    const newUid = db.prepare('SELECT imap_uid FROM messages WHERE id = ?').get(id).imap_uid;
    if (this.box?.id === f.id) this.sync({ expunge: false });
    return `[APPENDUID ${f.id} ${newUid}] APPEND completed`;
  },

  IDLE(args, { tag }) {
    this.send('+ idling');
    this.sync();
    this.idleTimer = setInterval(() => { try { this.sync(); } catch { /* connection gone */ } }, 4000);
    return new Promise((resolve) => {
      this.continuation = (line) => {
        clearInterval(this.idleTimer);
        if (line.trim().toUpperCase() !== 'DONE') this.send(`${tag} BAD Expected DONE`);
        else this.send(`${tag} OK IDLE terminated`);
        resolve(false);
      };
    });
  },

  CLOSE() {
    if (!this.readOnly) this.expungeDeleted(false);
    this.box = null;
    return 'CLOSE completed';
  },
  UNSELECT() { this.box = null; },

  EXPUNGE(args, { uid }) {
    if (this.readOnly) throw err('NO', 'Mailbox is read-only');
    const only = uid ? new Set(this.resolve(text(args[0]), true).map((x) => x.uid)) : null;
    this.expungeDeleted(true, only);
  },

  async FETCH(args, { uid }) {
    const items = parseFetchItems(args[1]);
    if (uid && !items.some((x) => x.name === 'UID')) items.unshift({ name: 'UID' });
    for (const { seq, uid: u } of this.resolve(text(args[0]), uid)) {
      const m = this.message(u);
      if (!m) continue;
      await this.fetchOne(seq, m, items);
    }
    if (uid) this.sync({ expunge: false });
  },

  STORE(args, { uid }) {
    if (this.readOnly) throw err('NO', 'Mailbox is read-only');
    const op = text(args[1]).toUpperCase();
    const mode = op.startsWith('+') ? 'add' : op.startsWith('-') ? 'remove' : 'set';
    const silent = op.endsWith('.SILENT');
    const flags = Array.isArray(args[2]) ? args[2] : args.slice(2);
    for (const { seq, uid: u } of this.resolve(text(args[0]), uid)) {
      const m = this.message(u);
      if (!m) continue;
      setFlags(this.user.id, m.id, flags, mode);
      const f = flagsOf(this.message(u), this.box.role);
      this.flags.set(u, f);
      if (!silent) this.send(`* ${seq} FETCH (${uid ? `UID ${u} ` : ''}FLAGS (${f}))`);
    }
  },

  COPY(args, { uid }) { return this.copyOrMove(args, uid, false); },
  MOVE(args, { uid }) { return this.copyOrMove(args, uid, true); },

  SEARCH(args, { uid }) {
    let a = args;
    if (text(a[0]).toUpperCase() === 'CHARSET') a = a.slice(2);
    const rows = this.rows('id, imap_uid, is_read, is_flagged, is_answered, imap_deleted, is_draft, from_addr, from_name, to_json, cc_json, bcc_json, subject, text_body, date, size, message_id, in_reply_to, refs');
    const seqOf = new Map(this.uids.map((u, i) => [u, i + 1]));
    const pred = parseSearch(a, this);
    const hits = rows.filter((r) => seqOf.has(r.imap_uid) && pred(r, seqOf.get(r.imap_uid)));
    this.send(`* SEARCH${hits.map((r) => ` ${uid ? r.imap_uid : seqOf.get(r.imap_uid)}`).join('')}`);
    if (uid) this.sync({ expunge: false });
  },
};

Object.assign(Session.prototype, {
  async authenticate(user, pass) {
    if (tooManyFailures(this.ip)) throw err('NO', '[UNAVAILABLE] Too many failed sign-ins. Try again later.');
    const u = clientLogin(user, pass);
    if (!u) {
      failures.get(this.ip).push(Date.now());
      await new Promise((r) => setTimeout(r, 500));
      throw err('NO', '[AUTHENTICATIONFAILED] Wrong email or password. If you use two-step verification, create an app password in Settings > Security.');
    }
    this.user = u;
    audit(u.id, 'imap.login', { ip: this.ip });
    return `[CAPABILITY ${CAPS}] Signed in`;
  },

  openBox(args, readOnly) {
    this.box = null;
    const f = folderForName(this.user.id, text(args[0]));
    if (!f) throw err('NO', '[NONEXISTENT] No such mailbox');
    this.selectBox(f, readOnly);
    return `[${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${readOnly ? 'EXAMINE' : 'SELECT'} completed`;
  },

  list(args, kind) {
    let a = args;
    if (Array.isArray(a[0])) a = a.slice(1); // LIST (SPECIAL-USE) "" "*"
    const ref = decodeMailbox(text(a[0]));
    const pattern = decodeMailbox(text(a[1]));
    if (pattern === '') { this.send(`* ${kind} (\\Noselect) "/" ""`); return; }
    const folders = store.listFolders(this.user.id);
    const all = folders.map((f) => (f.role === 'inbox' ? 'INBOX' : f.name));
    for (const f of folders) {
      const display = f.role === 'inbox' ? 'INBOX' : f.name;
      if (!listMatch(ref + pattern, display)) continue;
      const attrs = [all.some((n) => n.startsWith(`${display}/`)) ? '\\HasChildren' : '\\HasNoChildren'];
      if (ROLE_ATTR[f.role]) attrs.push(ROLE_ATTR[f.role]);
      this.send(`* ${kind} (${attrs.join(' ')}) "/" ${q(f.role === 'inbox' ? 'INBOX' : encodeMailbox(f.name))}`);
    }
  },

  expungeDeleted(report, onlyUids) {
    const rows = db.prepare('SELECT id, imap_uid FROM messages WHERE folder_id = ? AND user_id = ? AND imap_deleted = 1 ORDER BY imap_uid DESC').all(this.box.id, this.user.id);
    for (const r of rows) {
      if (onlyUids && !onlyUids.has(r.imap_uid)) continue;
      store.purgeMessage(r.id);
      const i = this.uids.indexOf(r.imap_uid);
      if (i >= 0) {
        if (report) this.send(`* ${i + 1} EXPUNGE`);
        this.uids.splice(i, 1);
        this.flags.delete(r.imap_uid);
      }
    }
  },

  copyOrMove(args, uid, move) {
    if (move && this.readOnly) throw err('NO', 'Mailbox is read-only');
    const dest = folderForName(this.user.id, text(args[1]));
    if (!dest) throw err('NO', '[TRYCREATE] No such mailbox');
    const src = [];
    const dst = [];
    const targets = this.resolve(text(args[0]), uid);
    for (const { uid: u } of targets) {
      const m = this.message(u);
      if (!m) continue;
      let newId;
      if (move && dest.id !== this.box.id) {
        db.prepare('UPDATE messages SET folder_id = ? WHERE id = ?').run(dest.id, m.id);
        newId = m.id;
      } else {
        newId = store.copyMessage(this.user.id, m.id, dest.id);
      }
      src.push(u);
      dst.push(db.prepare('SELECT imap_uid FROM messages WHERE id = ?').get(newId).imap_uid);
    }
    const code = src.length ? `[COPYUID ${dest.id} ${src.join(',')} ${dst.join(',')}] ` : '';
    if (move) {
      if (code) this.send(`* OK ${code}Moved`);
      // Report the moved messages as expunged (highest first so numbers stay valid)
      for (const u of [...src].sort((a, b) => b - a)) {
        const i = this.uids.indexOf(u);
        if (i >= 0 && dest.id !== this.box.id) { this.send(`* ${i + 1} EXPUNGE`); this.uids.splice(i, 1); this.flags.delete(u); }
      }
      return `${uid ? 'UID ' : ''}MOVE completed`;
    }
    if (this.box.id === dest.id) this.sync({ expunge: false });
    return `${code}${uid ? 'UID ' : ''}COPY completed`;
  },

  async fetchOne(seq, m, items) {
    const parts = [];
    let raw = null;
    let root = null;
    const needRaw = items.some((x) => !['UID', 'FLAGS', 'INTERNALDATE'].includes(x.name));
    if (needRaw) { raw = await rawOf(m); root = parseNode(raw); }
    let markSeen = false;
    for (const it of items) {
      switch (it.name) {
        case 'UID': parts.push(`UID ${m.imap_uid}`); break;
        case 'FLAGS': parts.push(`FLAGS (${flagsOf(m, this.box.role)})`); break;
        case 'INTERNALDATE': parts.push(`INTERNALDATE "${imapDate(m.date)}"`); break;
        case 'RFC822.SIZE': parts.push(`RFC822.SIZE ${raw.length}`); break;
        case 'ENVELOPE': parts.push(`ENVELOPE ${envelope(root)}`); break;
        case 'BODYSTRUCTURE': parts.push(`BODYSTRUCTURE ${bodyStructure(root, true)}`); break;
        case 'BODY': parts.push(`BODY ${bodyStructure(root, false)}`); break;
        case 'RFC822': parts.push('RFC822 ', raw); markSeen = true; break;
        case 'RFC822.HEADER': parts.push('RFC822.HEADER ', root.headerRaw); break;
        case 'RFC822.TEXT': parts.push('RFC822.TEXT ', root.body); markSeen = true; break;
        case 'SECTION': {
          let data = section(raw, root, it.section) || Buffer.alloc(0);
          let key = `BODY[${it.section}]`;
          if (it.start !== undefined) {
            data = data.subarray(it.start, it.start + it.length);
            key += `<${it.start}>`;
          }
          parts.push(`${key} `, data);
          if (!it.peek) markSeen = true;
          break;
        }
        default:
      }
    }
    if (markSeen && !m.is_read && !this.readOnly) {
      db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(m.id);
      m.is_read = 1;
      const f = flagsOf(m, this.box.role);
      this.flags.set(m.imap_uid, f);
      if (!items.some((x) => x.name === 'FLAGS')) parts.push(`FLAGS (${f})`);
    }
    // Join items with spaces; literal buffers are preceded by their {n} marker
    const out = [`* ${seq} FETCH (`];
    let first = true;
    for (const p of parts) {
      if (Buffer.isBuffer(p)) { out.push(`{${p.length}}\r\n`, p); continue; }
      if (!first) out.push(' ');
      out.push(p);
      first = false;
    }
    out.push(')');
    this.send(...out);
  },
});

function parseFetchItems(spec) {
  const MACROS = { ALL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'], FAST: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'], FULL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'] };
  let list = Array.isArray(spec) ? spec : [spec];
  if (list.length === 1 && MACROS[text(list[0]).toUpperCase()]) list = MACROS[text(list[0]).toUpperCase()];
  return list.map((x) => {
    const s = text(x);
    const m = s.match(/^BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i);
    if (m) return { name: 'SECTION', peek: !!m[1], section: m[2], start: m[3] !== undefined ? Number(m[3]) : undefined, length: m[4] !== undefined ? Number(m[4]) : undefined };
    const n = s.toUpperCase();
    if (!['UID', 'FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODYSTRUCTURE', 'BODY', 'RFC822', 'RFC822.HEADER', 'RFC822.TEXT', 'MODSEQ'].includes(n)) throw err('BAD', `Unknown fetch item ${s}`);
    return { name: n };
  });
}

// ------------------------------------------------------------ SEARCH

function parseSearch(tokens, session) {
  let i = 0;
  const has = (hay, needle) => String(hay || '').toLowerCase().includes(String(needle).toLowerCase());
  const people = (json) => JSON.parse(json || '[]').map((p) => `${p.name} <${p.address}>`).join(', ');
  function key() {
    const t = tokens[i++];
    if (Array.isArray(t)) { const sub = parseSearch(t, session); return sub; }
    const k = text(t).toUpperCase();
    const arg = () => text(tokens[i++]);
    switch (k) {
      case 'ALL': case 'OLD': return () => true;
      case 'NEW': case 'UNSEEN': return (r) => !r.is_read;
      case 'SEEN': return (r) => !!r.is_read;
      case 'RECENT': return () => false;
      case 'ANSWERED': return (r) => !!r.is_answered;
      case 'UNANSWERED': return (r) => !r.is_answered;
      case 'FLAGGED': return (r) => !!r.is_flagged;
      case 'UNFLAGGED': return (r) => !r.is_flagged;
      case 'DELETED': return (r) => !!r.imap_deleted;
      case 'UNDELETED': return (r) => !r.imap_deleted;
      case 'DRAFT': return (r) => !!r.is_draft || session.box.role === 'drafts';
      case 'UNDRAFT': return (r) => !r.is_draft && session.box.role !== 'drafts';
      case 'KEYWORD': arg(); return () => false;
      case 'UNKEYWORD': arg(); return () => true;
      case 'FROM': { const v = arg(); return (r) => has(`${r.from_name} <${r.from_addr}>`, v); }
      case 'TO': { const v = arg(); return (r) => has(people(r.to_json), v); }
      case 'CC': { const v = arg(); return (r) => has(people(r.cc_json), v); }
      case 'BCC': { const v = arg(); return (r) => has(people(r.bcc_json), v); }
      case 'SUBJECT': { const v = arg(); return (r) => has(r.subject, v); }
      case 'BODY': { const v = arg(); return (r) => has(r.text_body, v); }
      case 'TEXT': { const v = arg(); return (r) => has(`${r.subject}\n${r.from_name} ${r.from_addr}\n${people(r.to_json)}\n${r.text_body}`, v); }
      case 'HEADER': {
        const f = arg().toLowerCase();
        const v = arg();
        const col = { 'message-id': 'message_id', 'in-reply-to': 'in_reply_to', references: 'refs', subject: 'subject', from: 'from_addr' }[f];
        if (f === 'to' || f === 'cc') return (r) => has(people(r[`${f}_json`]), v);
        return (r) => (col ? has(r[col], v) : false);
      }
      case 'LARGER': { const n = Number(arg()); return (r) => r.size > n; }
      case 'SMALLER': { const n = Number(arg()); return (r) => r.size < n; }
      case 'BEFORE': case 'SENTBEFORE': { const d = parseSearchDate(arg()); return (r) => dayOf(r.date) < d; }
      case 'ON': case 'SENTON': { const d = parseSearchDate(arg()); return (r) => dayOf(r.date) === d; }
      case 'SINCE': case 'SENTSINCE': { const d = parseSearchDate(arg()); return (r) => dayOf(r.date) >= d; }
      case 'NOT': { const k1 = key(); return (r, s) => !k1(r, s); }
      case 'OR': { const k1 = key(); const k2 = key(); return (r, s) => k1(r, s) || k2(r, s); }
      case 'UID': { const set = new Set(session.resolve(arg(), true).map((x) => x.uid)); return (r) => set.has(r.imap_uid); }
      default:
        if (/^[\d*:,]+$/.test(k)) { const set = new Set(session.resolve(k, false).map((x) => x.seq)); return (r, s) => set.has(s); }
        throw err('BAD', `Unknown search key ${k}`);
    }
  }
  const keys = [];
  while (i < tokens.length) keys.push(key());
  return (r, s) => keys.every((k) => k(r, s));
}

// ------------------------------------------------------------ server

export function startImap() {
  const c = config.imap;
  const sockets = new Set();
  const handler = (secure) => (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    try { new Session(socket, secure); } catch (e) { console.error('[imap]', e); socket.destroy(); }
  };
  const server = c.tls && c.tlsKey && c.tlsCert
    ? tls.createServer({ key: fs.readFileSync(c.tlsKey), cert: fs.readFileSync(c.tlsCert) }, handler(true))
    : net.createServer(handler(false));
  server._arzioSockets = sockets;
  server.on('error', (e) => console.error('[imap] error', e.message));
  server.listen(c.port, c.host, () => console.log(`[imap] listening on ${c.host}:${c.port}${c.tls ? ' (TLS)' : ''}`));
  return server;
}
