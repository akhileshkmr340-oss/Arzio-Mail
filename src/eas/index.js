// Exchange ActiveSync (protocol 12.0 to 14.1): the built-in mail apps on
// iPhone and Android, Outlook for iOS/Android, Samsung Email, Windows Mail and
// others add an Arzio account as "Exchange" and get mail, calendar, contacts
// and tasks with push.
//
// Endpoint: /Microsoft-Server-ActiveSync. Discovery: /autodiscover/autodiscover.xml.
// Sign in with the Arzio address and password (an app password with two-step
// verification on).
import express from 'express';
import crypto from 'node:crypto';
import { simpleParser } from 'mailparser';
import { db } from '../db.js';
import { config } from '../config.js';
import { clientLogin, getUser } from '../auth.js';
import * as store from '../mail/store.js';
import { sendMail } from '../mail/delivery.js';
import * as cal from '../calendar/service.js';
import { audit } from '../audit.js';
import { E, encode, decode, child, kids, textOf, toXml } from './wbxml.js';
import * as it from './items.js';

db.exec(`
CREATE TABLE IF NOT EXISTS eas_devices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_type TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  friendly_name TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT '',
  policy_key TEXT,
  pending_key TEXT,
  status TEXT NOT NULL DEFAULT 'allowed',   -- allowed | blocked | wipe | wiped
  last_sync_json TEXT,
  ping_json TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  wiped_at TEXT,
  UNIQUE(user_id, device_id)
);
CREATE TABLE IF NOT EXISTS eas_state (
  id INTEGER PRIMARY KEY,
  device_row INTEGER NOT NULL REFERENCES eas_devices(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,                -- folder hierarchy: '_folders'
  sync_key INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  prev_key INTEGER,
  prev_state_json TEXT,
  options_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(device_row, collection)
);
`);

const VERSIONS = '12.0,12.1,14.0,14.1';
const COMMANDS = 'Sync,SendMail,SmartForward,SmartReply,GetAttachment,FolderSync,FolderCreate,FolderDelete,FolderUpdate,MoveItems,GetItemEstimate,MeetingResponse,Search,Settings,Ping,ItemOperations,Provision';
const DEBUG = /^(1|true|yes)$/i.test(process.env.ARZIO_EAS_DEBUG || '');
const MAX_HEARTBEAT = Math.max(60, Number(process.env.ARZIO_EAS_MAX_HEARTBEAT || 1680)); // seconds; keep under the proxy timeout
const POLL_MS = Math.max(200, Number(process.env.ARZIO_EAS_POLL_MS || 5000));
const REQUIRE_PASSCODE = Number(process.env.ARZIO_EAS_REQUIRE_PASSCODE || 0); // minimum length, 0 = no passcode rule

export const eas = express.Router();
eas.use(['/Microsoft-Server-ActiveSync', '/autodiscover'], express.raw({ type: () => true, limit: '60mb' }));

// ------------------------------------------------------------ helpers
const statusCodes = { Sync: 'AirSync:Sync', FolderSync: 'FolderHierarchy:FolderSync', FolderCreate: 'FolderHierarchy:FolderCreate', FolderDelete: 'FolderHierarchy:FolderDelete',
  FolderUpdate: 'FolderHierarchy:FolderUpdate', GetItemEstimate: 'GetItemEstimate:GetItemEstimate', Ping: 'Ping:Ping', MoveItems: 'Move:MoveItems',
  ItemOperations: 'ItemOperations:ItemOperations', Settings: 'Settings:Settings', Search: 'Search:Search', MeetingResponse: 'MeetingResponse:MeetingResponse',
  SendMail: 'ComposeMail:SendMail', SmartReply: 'ComposeMail:SmartReply', SmartForward: 'ComposeMail:SmartForward', Provision: 'Provision:Provision' };
const ROOT_STATUS = { 'AirSync:Sync': 'AirSync:Status', 'FolderHierarchy:FolderSync': 'FolderHierarchy:Status', 'FolderHierarchy:FolderCreate': 'FolderHierarchy:Status',
  'FolderHierarchy:FolderDelete': 'FolderHierarchy:Status', 'FolderHierarchy:FolderUpdate': 'FolderHierarchy:Status', 'GetItemEstimate:GetItemEstimate': 'GetItemEstimate:Status',
  'Ping:Ping': 'Ping:Status', 'Move:MoveItems': 'Move:Status', 'ItemOperations:ItemOperations': 'ItemOperations:Status', 'Settings:Settings': 'Settings:Status',
  'Search:Search': 'Search:Status', 'MeetingResponse:MeetingResponse': 'MeetingResponse:Status', 'ComposeMail:SendMail': 'ComposeMail:Status',
  'ComposeMail:SmartReply': 'ComposeMail:Status', 'ComposeMail:SmartForward': 'ComposeMail:Status', 'Provision:Provision': 'Provision:Status' };

function send(res, tree) {
  if (DEBUG) console.log('[eas] >>\n' + toXml(tree));
  res.status(200).type('application/vnd.ms-sync.wbxml').send(encode(tree));
}
const v14 = (req) => parseFloat(req.eas.version) >= 14;
/** A command-level error: 14.x puts it in the body, 12.x uses HTTP status codes */
function fail(req, res, status, http = 500) {
  const root = statusCodes[req.eas.cmd];
  if (v14(req) && root) return send(res, E(root, [E(ROOT_STATUS[root], status)]));
  res.status(http).end();
}

// The query string comes as name=value pairs or base64 (MS-ASHTTP 2.2.1.1.1.1)
const CMD_CODES = ['Sync', 'SendMail', 'SmartForward', 'SmartReply', 'GetAttachment', null, null, null, null, 'FolderSync', 'FolderCreate', 'FolderDelete', 'FolderUpdate', 'MoveItems', 'GetItemEstimate', 'MeetingResponse', 'Search', 'Settings', 'Ping', 'ItemOperations', 'Provision', 'ResolveRecipients', 'ValidateCert'];
const PARAM_CODES = { 0: 'AttachmentName', 1: 'CollectionId', 3: 'ItemId', 4: 'LongId', 6: 'Occurrence', 7: 'Options', 8: 'User' };
function readQuery(req) {
  const qs = req.originalUrl.split('?')[1] || '';
  if (!qs || qs.includes('=')) {
    const p = new URLSearchParams(qs);
    return { cmd: p.get('Cmd'), user: p.get('User'), deviceId: p.get('DeviceId'), deviceType: p.get('DeviceType'), params: Object.fromEntries(p),
      version: req.get('MS-ASProtocolVersion') || '14.1', policyKey: req.get('X-MS-PolicyKey') || null };
  }
  const b = Buffer.from(decodeURIComponent(qs), 'base64');
  let i = 0;
  const ver = b[i++]; const cmd = CMD_CODES[b[i++]]; i += 2;
  const devLen = b[i++]; const deviceId = b.subarray(i, i + devLen).toString('hex').toUpperCase(); i += devLen;
  const pkLen = b[i++]; const policyKey = pkLen === 4 ? String(b.readUInt32LE(i)) : null; i += pkLen;
  const dtLen = b[i++]; const deviceType = b.subarray(i, i + dtLen).toString('utf8'); i += dtLen;
  const params = {};
  while (i < b.length) { const tag = b[i++]; const len = b[i++]; params[PARAM_CODES[tag] || tag] = b.subarray(i, i + len).toString('utf8'); i += len; }
  if (params.Options) params.Options = params.Options.charCodeAt(0);
  return { cmd, user: params.User, deviceId, deviceType, params, version: (ver / 10).toFixed(1), policyKey };
}

// ------------------------------------------------------------ sign-in (HTTP Basic)
const failures = new Map();
function auth(req, res, next) {
  const m = String(req.headers.authorization || '').match(/^Basic\s+(\S+)$/i);
  const recent = (failures.get(req.ip) || []).filter((t) => Date.now() - t < 15 * 60e3);
  failures.set(req.ip, recent);
  if (m && recent.length < 10) {
    let [name, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    name = name.replace(/^[^\\]*\\/, ''); // DOMAIN\user
    const u = clientLogin(name, rest.join(':'));
    if (u) { req.user = u; return next(); }
    recent.push(Date.now());
  }
  res.set('WWW-Authenticate', `Basic realm="${config.serviceName}"`).status(401).end();
}

// ------------------------------------------------------------ devices and state
function device(req) {
  const { deviceId, deviceType } = req.eas;
  if (!deviceId || !/^[\w-]{1,64}$/.test(deviceId)) return null;
  let d = db.prepare('SELECT * FROM eas_devices WHERE user_id = ? AND device_id = ?').get(req.user.id, deviceId);
  if (!d) {
    db.prepare('INSERT INTO eas_devices (user_id, device_id, device_type, user_agent, protocol) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, deviceId, String(deviceType || '').slice(0, 64), String(req.get('user-agent') || '').slice(0, 200), req.eas.version);
    d = db.prepare('SELECT * FROM eas_devices WHERE user_id = ? AND device_id = ?').get(req.user.id, deviceId);
    audit(req.user.id, 'security.device.added', { deviceId, deviceType, userAgent: req.get('user-agent') || '' });
  } else {
    db.prepare("UPDATE eas_devices SET last_seen = datetime('now'), user_agent = ?, protocol = ? WHERE id = ?").run(String(req.get('user-agent') || d.user_agent).slice(0, 200), req.eas.version, d.id);
  }
  return d;
}
function getState(dev, coll) {
  return db.prepare('SELECT * FROM eas_state WHERE device_row = ? AND collection = ?').get(dev.id, coll);
}
function putState(dev, coll, key, state, prevKey, prevState, options) {
  db.prepare(`INSERT INTO eas_state (device_row, collection, sync_key, state_json, prev_key, prev_state_json, options_json) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_row, collection) DO UPDATE SET sync_key = excluded.sync_key, state_json = excluded.state_json, prev_key = excluded.prev_key,
      prev_state_json = excluded.prev_state_json, options_json = COALESCE(excluded.options_json, eas_state.options_json), updated_at = datetime('now')`)
    .run(dev.id, coll, key, JSON.stringify(state), prevKey ?? null, prevState ? JSON.stringify(prevState) : null, options ? JSON.stringify(options) : null);
}
/** The state the client's sync key refers to, or null when the key is unknown */
const items = (json) => { const s = JSON.parse(json); delete s._clients; return s; };
function stateForKey(row, key) {
  if (!row) return null;
  if (Number(key) === row.sync_key) return items(row.state_json);
  if (row.prev_key !== null && Number(key) === row.prev_key && row.prev_state_json) return items(row.prev_state_json);
  return null;
}
const newKey = (row) => (row?.sync_key || 0) + 1;

// ------------------------------------------------------------ collections
const FOLDER_TYPES = { inbox: 2, drafts: 3, trash: 4, sent: 5 };
function folderList(userId) {
  const out = [];
  for (const f of store.listFolders(userId)) {
    if (f.role === 'recoverable') continue;
    out.push({ id: `f${f.id}`, parent: '0', name: f.name, type: FOLDER_TYPES[f.role] || 12 });
  }
  out.push({ id: 'cal', parent: '0', name: 'Calendar', type: 8 }, { id: 'con', parent: '0', name: 'Contacts', type: 9 }, { id: 'task', parent: '0', name: 'Tasks', type: 7 });
  return out;
}
function collection(userId, id) {
  if (id === 'cal') return { kind: 'calendar', cls: 'Calendar' };
  if (id === 'con') return { kind: 'contacts', cls: 'Contacts' };
  if (id === 'task') return { kind: 'tasks', cls: 'Tasks' };
  const m = /^f(\d+)$/.exec(String(id || ''));
  const f = m && store.folderById(userId, Number(m[1]));
  return f && f.role !== 'recoverable' ? { kind: 'mail', cls: 'Email', folder: f } : null;
}
function currentItems(userId, coll, options) {
  const cutoff = it.filterCutoff(options?.filterType, coll.kind);
  if (coll.kind === 'mail') return it.mailItems(userId, coll.folder.id, cutoff);
  if (coll.kind === 'calendar') return it.eventItems(userId, cutoff);
  if (coll.kind === 'contacts') return it.contactItems(userId);
  return it.taskItems(userId, options?.filterType);
}
function diff(state, current) {
  const changes = [];
  for (const [sid, ver] of current) {
    if (!(sid in state)) changes.push({ op: 'Add', sid, ver });
    else if (state[sid] !== ver) changes.push({ op: 'Change', sid, ver });
  }
  const cur = new Set(current.keys());
  for (const sid of Object.keys(state)) if (!cur.has(sid)) changes.push({ op: 'Delete', sid });
  return changes;
}
const itemId = (sid) => Number(String(sid).split(':')[1]);
async function itemData(userId, coll, sid, options) {
  const id = itemId(sid);
  if (coll.kind === 'mail') return it.mailData(userId, id, options);
  if (coll.kind === 'calendar') return it.eventData(userId, id, options);
  if (coll.kind === 'contacts') return it.contactData(userId, id);
  return it.taskData(userId, id);
}
function readOptions(node, saved) {
  if (!node) return saved || { filterType: 0, bodyPrefs: [{ type: 1, size: 32768 }], mimeSupport: 0 };
  return {
    filterType: Number(textOf(node, 'AirSync:FilterType') || 0),
    bodyPrefs: it.readBodyPrefs(node),
    mimeSupport: Number(textOf(node, 'AirSync:MIMESupport') || 0),
  };
}

// ------------------------------------------------------------ waiting for changes (Ping, Sync with Wait)
const waiters = new Map(); // device row -> function to end the wait early
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
async function waitFor(dev, seconds, check) {
  waiters.get(dev.id)?.();
  let stop = false;
  waiters.set(dev.id, () => { stop = true; });
  const until = Date.now() + seconds * 1000;
  try {
    while (!stop && !shuttingDown && Date.now() < until) {
      const r = await check();
      if (r) return r;
      await sleep(Math.min(POLL_MS, Math.max(50, until - Date.now())));
    }
    return null;
  } finally {
    if (waiters.get(dev.id) && stop === false) waiters.delete(dev.id);
  }
}
let shuttingDown = false;
/** Ends open long polls so a restart is quick; phones simply reconnect */
export function stopEas() { shuttingDown = true; for (const end of waiters.values()) end(); }

function hierarchyChanged(dev) {
  const row = getState(dev, '_folders');
  if (!row) return true;
  const state = JSON.parse(row.state_json);
  return folderList(dev.user_id).some((f) => state[f.id] !== `${f.name}|${f.type}`) || Object.keys(state).length !== folderList(dev.user_id).length;
}
function collectionChanged(dev, id) {
  const row = getState(dev, id);
  const coll = collection(dev.user_id, id);
  if (!coll || !row || row.sync_key === 0) return false;
  const opts = row.options_json ? JSON.parse(row.options_json) : null;
  return diff(items(row.state_json), currentItems(dev.user_id, coll, opts)).length > 0;
}

// ------------------------------------------------------------ routes
eas.options('/Microsoft-Server-ActiveSync', (req, res) => {
  res.set({ 'MS-Server-ActiveSync': '14.1', 'MS-ASProtocolVersions': VERSIONS, 'MS-ASProtocolCommands': COMMANDS, Allow: 'OPTIONS,POST', 'Cache-Control': 'private' }).status(200).end();
});

eas.post('/Microsoft-Server-ActiveSync', auth, async (req, res) => {
  try {
    req.eas = readQuery(req);
    res.set({ 'MS-Server-ActiveSync': '14.1', 'Cache-Control': 'private' });
    const handler = HANDLERS[req.eas.cmd];
    if (!handler) return res.status(501).end();
    if (parseFloat(req.eas.version) < 12) return res.status(400).end();
    const dev = device(req);
    if (!dev) return res.status(400).end();
    req.device = dev;
    if (dev.status === 'blocked') return res.status(403).end();
    const isRaw = /message\/rfc822/i.test(req.get('content-type') || '');
    req.wbxml = !isRaw && req.body?.length ? decode(req.body) : null;
    if (DEBUG) console.log(`[eas] << ${req.eas.cmd} ${req.user.email} ${dev.device_id}\n${req.wbxml ? toXml(req.wbxml) : ''}`);
    // Provisioning: a device must hold the current policy key (and is wiped when asked)
    if (req.eas.cmd !== 'Provision' && !(req.eas.cmd === 'Settings' && !dev.policy_key) && (dev.status === 'wipe' || !dev.policy_key || req.eas.policyKey !== dev.policy_key)) {
      if (v14(req) && statusCodes[req.eas.cmd]) return fail(req, res, dev.policy_key || dev.status === 'wipe' ? 144 : 142, 449);
      return res.status(449).end();
    }
    await handler(req, res);
  } catch (e) {
    console.error('[eas]', req.eas?.cmd, e);
    if (!res.headersSent) {
      if (e.status === 429) return fail(req, res, 113, 503);
      fail(req, res, 110, 500);
    }
  }
});

const HANDLERS = {
  // ---------------------------------------------------------- Provision
  async Provision(req, res) {
    const dev = req.device;
    const p = req.wbxml;
    const info = child(child(p, 'Settings:DeviceInformation'), 'Settings:Set');
    if (info) saveDeviceInfo(dev, info);
    const wipeAck = child(p, 'Provision:RemoteWipe');
    if (wipeAck) {
      db.prepare("UPDATE eas_devices SET status = 'wiped', wiped_at = datetime('now'), policy_key = NULL WHERE id = ?").run(dev.id);
      audit(dev.user_id, 'security.device.wiped', { deviceId: dev.device_id, status: textOf(wipeAck, 'Provision:Status') });
      return send(res, E('Provision:Provision', [E('Provision:Status', 1)]));
    }
    if (dev.status === 'wipe' || dev.status === 'wiped') return send(res, E('Provision:Provision', [E('Provision:Status', 1), E('Provision:RemoteWipe')]));
    const policy = child(child(p, 'Provision:Policies'), 'Provision:Policy');
    const type = textOf(policy, 'Provision:PolicyType') || 'MS-EAS-Provisioning-WBXML';
    if (type !== 'MS-EAS-Provisioning-WBXML') return send(res, E('Provision:Provision', [E('Provision:Status', 1), E('Provision:Policies', [E('Provision:Policy', [E('Provision:PolicyType', type), E('Provision:Status', 3)])])]));
    const ackKey = textOf(policy, 'Provision:PolicyKey');
    if (ackKey) {
      // Step 2: the phone accepted the policy with the temporary key
      if (ackKey !== dev.pending_key) return send(res, E('Provision:Provision', [E('Provision:Status', 1), E('Provision:Policies', [E('Provision:Policy', [E('Provision:PolicyType', type), E('Provision:Status', 5)])])]));
      const final = String(crypto.randomInt(1, 2 ** 31));
      db.prepare('UPDATE eas_devices SET policy_key = ?, pending_key = NULL WHERE id = ?').run(final, dev.id);
      return send(res, E('Provision:Provision', [E('Provision:Status', 1), E('Provision:Policies', [E('Provision:Policy', [
        E('Provision:PolicyType', type), E('Provision:Status', 1), E('Provision:PolicyKey', final)])])]));
    }
    // Step 1: send the policy with a temporary key
    const temp = String(crypto.randomInt(1, 2 ** 31));
    db.prepare('UPDATE eas_devices SET pending_key = ? WHERE id = ?').run(temp, dev.id);
    return send(res, E('Provision:Provision', [
      info ? E('Settings:DeviceInformation', [E('Settings:Status', 1)]) : null,
      E('Provision:Status', 1),
      E('Provision:Policies', [E('Provision:Policy', [E('Provision:PolicyType', type), E('Provision:Status', 1), E('Provision:PolicyKey', temp),
        E('Provision:Data', [E('Provision:EASProvisionDoc', policyDoc())])])]),
    ]));
  },

  // ---------------------------------------------------------- FolderSync
  async FolderSync(req, res) {
    const dev = req.device;
    const key = textOf(req.wbxml, 'FolderHierarchy:SyncKey') ?? '0';
    if (key === '0') db.prepare('DELETE FROM eas_state WHERE device_row = ?').run(dev.id);
    const row = getState(dev, '_folders');
    const base = key === '0' ? {} : stateForKey(row, key);
    if (!base) return send(res, E('FolderHierarchy:FolderSync', [E('FolderHierarchy:Status', 9)]));
    const now = folderList(dev.user_id);
    const adds = []; const updates = []; const deletes = [];
    const next = {};
    for (const f of now) {
      next[f.id] = `${f.name}|${f.type}`;
      if (!(f.id in base)) adds.push(f); else if (base[f.id] !== next[f.id]) updates.push(f);
    }
    for (const id of Object.keys(base)) if (!(id in next)) deletes.push(id);
    const count = adds.length + updates.length + deletes.length;
    let outKey = row && key !== '0' ? (Number(key) === row.sync_key ? row.sync_key : row.prev_key) : 0;
    if (count || key === '0' || !row) { outKey = key === '0' ? 1 : newKey(row); putState(dev, '_folders', outKey, next, Number(key), base); }
    const f2n = (f) => [E('FolderHierarchy:ServerId', f.id), E('FolderHierarchy:ParentId', f.parent), E('FolderHierarchy:DisplayName', f.name), E('FolderHierarchy:Type', f.type)];
    send(res, E('FolderHierarchy:FolderSync', [
      E('FolderHierarchy:Status', 1), E('FolderHierarchy:SyncKey', outKey),
      E('FolderHierarchy:Changes', [E('FolderHierarchy:Count', count),
        ...deletes.map((id) => E('FolderHierarchy:Delete', [E('FolderHierarchy:ServerId', id)])),
        ...updates.map((f) => E('FolderHierarchy:Update', f2n(f))),
        ...adds.map((f) => E('FolderHierarchy:Add', f2n(f)))]),
    ]));
  },
  async FolderCreate(req, res) { return folderOp(req, res, 'create'); },
  async FolderDelete(req, res) { return folderOp(req, res, 'delete'); },
  async FolderUpdate(req, res) { return folderOp(req, res, 'update'); },

  // ---------------------------------------------------------- Sync
  async Sync(req, res) {
    const dev = req.device;
    let reqTree = req.wbxml;
    if (!reqTree) {
      // An empty Sync repeats the previous one
      if (!dev.last_sync_json) return send(res, E('AirSync:Sync', [E('AirSync:Status', 13)]));
      reqTree = JSON.parse(dev.last_sync_json, (k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data) : v));
    } else {
      db.prepare('UPDATE eas_devices SET last_sync_json = ? WHERE id = ?').run(JSON.stringify(reqTree), dev.id);
    }
    const colls = kids(child(reqTree, 'AirSync:Collections'), 'AirSync:Collection');
    const wait = Number(textOf(reqTree, 'AirSync:Wait') || 0) * 60 || Number(textOf(reqTree, 'AirSync:HeartbeatInterval') || 0);
    const globalWindow = Number(textOf(reqTree, 'AirSync:WindowSize') || 0);
    if (!colls.length) return send(res, E('AirSync:Sync', [E('AirSync:Status', 4)]));

    const run = async () => {
      const out = []; let anyChanges = false;
      for (const c of colls) {
        const r = await syncCollection(req, c, globalWindow);
        if (r.changed) anyChanges = true;
        out.push(r.node);
      }
      return { out, anyChanges };
    };
    let result = await run();
    const clientSent = colls.some((c) => child(c, 'AirSync:Commands') || textOf(c, 'AirSync:SyncKey') === '0');
    if (!result.anyChanges && !clientSent && wait > 0) {
      const ids = colls.map((c) => textOf(c, 'AirSync:CollectionId'));
      const hit = await waitFor(dev, Math.min(wait, MAX_HEARTBEAT), () => ids.some((id) => collectionChanged(dev, id)) || null);
      if (!hit) return res.status(200).end(); // nothing new: an empty answer
      result = await run();
    }
    send(res, E('AirSync:Sync', [E('AirSync:Collections', result.out)]));
  },

  // ---------------------------------------------------------- GetItemEstimate
  async GetItemEstimate(req, res) {
    const dev = req.device;
    const out = [];
    for (const c of kids(child(req.wbxml, 'GetItemEstimate:Collections'), 'GetItemEstimate:Collection')) {
      const id = textOf(c, 'GetItemEstimate:CollectionId');
      const key = textOf(c, 'AirSync:SyncKey');
      const coll = collection(dev.user_id, id);
      const row = getState(dev, id);
      const base = stateForKey(row, key);
      if (!coll) { out.push(E('GetItemEstimate:Response', [E('GetItemEstimate:Status', 2), E('GetItemEstimate:Collection', [E('GetItemEstimate:CollectionId', id)])])); continue; }
      if (!base) { out.push(E('GetItemEstimate:Response', [E('GetItemEstimate:Status', key === '0' ? 3 : 4), E('GetItemEstimate:Collection', [E('GetItemEstimate:CollectionId', id)])])); continue; }
      const opts = readOptions(child(c, 'AirSync:Options'), row.options_json ? JSON.parse(row.options_json) : null);
      const n = diff(base, currentItems(dev.user_id, coll, opts)).length;
      out.push(E('GetItemEstimate:Response', [E('GetItemEstimate:Status', 1), E('GetItemEstimate:Collection', [E('GetItemEstimate:CollectionId', id), E('GetItemEstimate:Estimate', n)])]));
    }
    send(res, E('GetItemEstimate:GetItemEstimate', out));
  },

  // ---------------------------------------------------------- Ping (push)
  async Ping(req, res) {
    const dev = req.device;
    let hb = Number(textOf(req.wbxml, 'Ping:HeartbeatInterval') || 0);
    let folders = kids(child(req.wbxml, 'Ping:Folders'), 'Ping:Folder').map((f) => textOf(f, 'Ping:Id'));
    if (req.wbxml && (hb || folders.length)) {
      const saved = dev.ping_json ? JSON.parse(dev.ping_json) : {};
      hb = hb || saved.hb; folders = folders.length ? folders : saved.folders || [];
      db.prepare('UPDATE eas_devices SET ping_json = ? WHERE id = ?').run(JSON.stringify({ hb, folders }), dev.id);
    } else if (dev.ping_json) ({ hb, folders } = JSON.parse(dev.ping_json));
    if (!hb || !folders?.length) return send(res, E('Ping:Ping', [E('Ping:Status', 3)]));
    if (hb < 60 || hb > 3540) return send(res, E('Ping:Ping', [E('Ping:Status', 5), E('Ping:HeartbeatInterval', hb < 60 ? 60 : MAX_HEARTBEAT)]));
    if (folders.length > 300) return send(res, E('Ping:Ping', [E('Ping:Status', 6), E('Ping:MaxFolders', 300)]));
    if (folders.some((id) => !collection(dev.user_id, id)) || hierarchyChanged(dev)) return send(res, E('Ping:Ping', [E('Ping:Status', 7)]));
    const check = () => { const ch = folders.filter((id) => collectionChanged(dev, id)); return ch.length ? ch : (hierarchyChanged(dev) ? 'folders' : null); };
    const changed = await waitFor(dev, Math.min(hb, MAX_HEARTBEAT), check);
    if (changed === 'folders') return send(res, E('Ping:Ping', [E('Ping:Status', 7)]));
    if (!changed) return send(res, E('Ping:Ping', [E('Ping:Status', 1)]));
    send(res, E('Ping:Ping', [E('Ping:Status', 2), E('Ping:Folders', changed.map((id) => E('Ping:Folder', id)))]));
  },

  // ---------------------------------------------------------- sending
  async SendMail(req, res) { return compose(req, res, 'send'); },
  async SmartReply(req, res) { return compose(req, res, 'reply'); },
  async SmartForward(req, res) { return compose(req, res, 'forward'); },

  // ---------------------------------------------------------- attachments (12.x)
  async GetAttachment(req, res) {
    const a = it.attachmentFor(req.user.id, req.eas.params.AttachmentName);
    if (!a?.data) return res.status(500).end();
    res.status(200).type(a.content_type || 'application/octet-stream').send(a.data);
  },

  // ---------------------------------------------------------- ItemOperations
  async ItemOperations(req, res) {
    const out = [];
    const u = req.user;
    for (const op of req.wbxml?.children || []) {
      if (op.tag === 'ItemOperations:Fetch') {
        const ref = textOf(op, 'AirSyncBase:FileReference');
        if (ref) {
          const a = it.attachmentFor(u.id, ref);
          out.push(E('ItemOperations:Fetch', a?.data ? [E('ItemOperations:Status', 1), E('AirSyncBase:FileReference', ref), E('ItemOperations:Properties', [
            E('AirSyncBase:ContentType', a.content_type || 'application/octet-stream'), E('ItemOperations:Data', a.data.toString('base64'))])]
            : [E('ItemOperations:Status', 15), E('AirSyncBase:FileReference', ref)]));
          continue;
        }
        const sid = textOf(op, 'AirSync:ServerId') || textOf(op, 'Search:LongId');
        const collId = textOf(op, 'AirSync:CollectionId') || (sid?.includes(':') ? (sid.startsWith('cal') || sid.startsWith('con') || sid.startsWith('task') ? sid.split(':')[0] : `f${sid.split(':')[0]}`) : null);
        const coll = collection(u.id, collId);
        const opts = readOptions(child(op, 'ItemOperations:Options'));
        const data = coll && sid ? await itemData(u.id, coll, sid, opts) : null;
        out.push(E('ItemOperations:Fetch', data ? [E('ItemOperations:Status', 1), E('AirSync:CollectionId', collId), E('AirSync:ServerId', sid), E('AirSync:Class', coll.cls), E('ItemOperations:Properties', data)]
          : [E('ItemOperations:Status', 6), sid ? E('AirSync:ServerId', sid) : null]));
      } else if (op.tag === 'ItemOperations:EmptyFolderContents') {
        const coll = collection(u.id, textOf(op, 'AirSync:CollectionId'));
        if (coll?.kind === 'mail') {
          for (const m of db.prepare('SELECT id FROM messages WHERE user_id = ? AND folder_id = ?').all(u.id, coll.folder.id)) {
            if (coll.folder.role === 'trash') store.purgeMessage(m.id); else store.deleteMessage(u.id, m.id);
          }
        }
        out.push(E('ItemOperations:EmptyFolderContents', [E('ItemOperations:Status', coll?.kind === 'mail' ? 1 : 2), E('AirSync:CollectionId', textOf(op, 'AirSync:CollectionId') || '')]));
      }
    }
    send(res, E('ItemOperations:ItemOperations', [E('ItemOperations:Status', 1), E('ItemOperations:Response', out)]));
  },

  // ---------------------------------------------------------- MoveItems
  async MoveItems(req, res) {
    const dev = req.device;
    const out = [];
    for (const mv of kids(req.wbxml, 'Move:Move')) {
      const src = textOf(mv, 'Move:SrcMsgId'); const srcF = textOf(mv, 'Move:SrcFldId'); const dstF = textOf(mv, 'Move:DstFldId');
      const s = collection(dev.user_id, srcF); const d = collection(dev.user_id, dstF);
      const node = (status, dst) => E('Move:Response', [E('Move:SrcMsgId', src), E('Move:Status', status), dst ? E('Move:DstMsgId', dst) : null]);
      if (s?.kind !== 'mail') { out.push(node(1)); continue; }
      if (d?.kind !== 'mail') { out.push(node(2)); continue; }
      if (srcF === dstF) { out.push(node(4)); continue; }
      const msg = store.getMessage(dev.user_id, itemId(src));
      if (!msg || msg.folder_id !== s.folder.id) { out.push(node(1)); continue; }
      const m = store.updateMessage(dev.user_id, msg.id, { folder_id: d.folder.id });
      const dst = `${d.folder.id}:${msg.id}`;
      // The phone already shows the move: keep both folders' state in step
      for (const [id, fn] of [[srcF, (st) => { delete st[src]; }], [dstF, (st) => { st[dst] = it.mailVersion(m); }]]) {
        const row = getState(dev, id);
        if (row) { const st = JSON.parse(row.state_json); fn(st); db.prepare('UPDATE eas_state SET state_json = ? WHERE id = ?').run(JSON.stringify(st), row.id); }
      }
      out.push(node(3, dst));
    }
    send(res, E('Move:MoveItems', out));
  },

  // ---------------------------------------------------------- MeetingResponse
  async MeetingResponse(req, res) {
    const u = req.user;
    const out = [];
    for (const r of kids(req.wbxml, 'MeetingResponse:Request')) {
      const status = { 1: 'accepted', 2: 'tentative', 3: 'declined' }[textOf(r, 'MeetingResponse:UserResponse')];
      const reqId = textOf(r, 'MeetingResponse:RequestId') || textOf(r, 'Search:LongId') || '';
      let eventId = null;
      if (reqId.startsWith('cal:')) eventId = itemId(reqId);
      else {
        const m = store.getMessage(u.id, itemId(reqId));
        eventId = m?.calendar?.eventId || null;
      }
      const ev = eventId && cal.getEvent(u.id, eventId);
      if (!ev || !status) { out.push(E('MeetingResponse:Result', [E('MeetingResponse:RequestId', reqId), E('MeetingResponse:Status', 2)])); continue; }
      await cal.respond(u, ev.id, status);
      out.push(E('MeetingResponse:Result', [E('MeetingResponse:RequestId', reqId), E('MeetingResponse:Status', 1), status !== 'declined' ? E('MeetingResponse:CalendarId', `cal:${ev.id}`) : null]));
    }
    send(res, E('MeetingResponse:MeetingResponse', out));
  },

  // ---------------------------------------------------------- Search (directory and mailbox)
  async Search(req, res) {
    const u = req.user;
    const st = child(req.wbxml, 'Search:Store');
    const name = textOf(st, 'Search:Name');
    const range = /^(\d+)-(\d+)$/.exec(textOf(child(st, 'Search:Options'), 'Search:Range') || '0-49') || [0, 0, 49];
    const [from, to] = [Number(range[1]), Math.min(Number(range[2]), Number(range[1]) + 99)];
    let results = []; let total = 0;
    if (name === 'GAL') {
      const q = String(textOf(st, 'Search:Query') || '').trim().toLowerCase();
      if (q.length < 1) return send(res, E('Search:Search', [E('Search:Status', 1), E('Search:Response', [E('Search:Store', [E('Search:Status', 2)])])]));
      const like = `%${q.replace(/[%_]/g, '')}%`;
      // Colleagues in a private organization, plus your own contacts. Free accounts only see their contacts.
      const org = db.prepare('SELECT kind FROM organizations WHERE id = ?').get(u.org_id);
      const people = [
        ...(org?.kind === 'private' ? db.prepare("SELECT name, email, '' AS phone, '' AS company, '' AS title FROM users WHERE org_id = ? AND is_disabled = 0 AND (lower(name) LIKE ? OR lower(email) LIKE ?) ORDER BY name LIMIT 200")
          .all(u.org_id, like, like) : []),
        ...db.prepare('SELECT name, email, phone, company, job_title AS title FROM contacts WHERE user_id = ? AND is_saved = 1 AND (lower(name) LIKE ? OR lower(email) LIKE ?) ORDER BY name LIMIT 200').all(u.id, like, like),
      ];
      const seen = new Set();
      const uniq = people.filter((p) => !seen.has(p.email) && seen.add(p.email) && !p.email.endsWith('.invalid'));
      total = uniq.length;
      results = uniq.slice(from, to + 1).map((p) => {
        const parts = String(p.name || '').split(/\s+/);
        return E('Search:Result', [E('Search:Properties', [
          E('GAL:DisplayName', p.name || p.email), E('GAL:EmailAddress', p.email), E('GAL:Alias', p.email.split('@')[0]),
          parts.length > 1 ? E('GAL:FirstName', parts.slice(0, -1).join(' ')) : null, parts.length > 1 ? E('GAL:LastName', parts.at(-1)) : null,
          p.phone ? E('GAL:MobilePhone', p.phone) : null, p.company ? E('GAL:Company', p.company) : null, p.title ? E('GAL:Title', p.title) : null,
        ])]);
      });
    } else if (name === 'Mailbox') {
      const query = child(st, 'Search:Query');
      const and = child(query, 'Search:And') || query;
      const text = textOf(and, 'Search:FreeText') || '';
      const collId = textOf(and, 'AirSync:CollectionId');
      const coll = collId ? collection(u.id, collId) : null;
      const opts = readOptions(child(st, 'Search:Options'));
      const found = text ? store.listMessages(u.id, { q: text, folderId: coll?.kind === 'mail' ? coll.folder.id : undefined, limit: 100 }) : [];
      const list = Array.isArray(found) ? found : found.messages || [];
      total = list.length;
      for (const m of list.slice(from, to + 1)) {
        const sid = `${m.folder_id}:${m.id}`;
        results.push(E('Search:Result', [E('AirSync:Class', 'Email'), E('Search:LongId', sid), E('AirSync:CollectionId', `f${m.folder_id}`),
          E('Search:Properties', await it.mailData(u.id, m.id, opts))]));
      }
    } else {
      return send(res, E('Search:Search', [E('Search:Status', 1), E('Search:Response', [E('Search:Store', [E('Search:Status', 3)])])]));
    }
    send(res, E('Search:Search', [E('Search:Status', 1), E('Search:Response', [E('Search:Store', [
      E('Search:Status', 1), ...results, total ? E('Search:Range', `${from}-${from + results.length - 1}`) : null, E('Search:Total', total),
    ])])]));
  },

  // ---------------------------------------------------------- Settings
  async Settings(req, res) {
    const u = getUser(req.user.id);
    const out = [E('Settings:Status', 1)];
    const p = req.wbxml;
    const oof = child(p, 'Settings:Oof');
    if (oof && child(oof, 'Settings:Get')) {
      const state = !u.ooo_enabled ? 0 : (u.ooo_start || u.ooo_end ? 2 : 1);
      const msg = (applies) => E('Settings:OofMessage', [E(applies), E('Settings:Enabled', u.ooo_enabled ? 1 : 0), E('Settings:ReplyMessage', u.ooo_message || ''), E('Settings:BodyType', 'Text')]);
      out.push(E('Settings:Oof', [E('Settings:Status', 1), E('Settings:Get', [E('Settings:OofState', state),
        u.ooo_start ? E('Settings:StartTime', it.isoMs(u.ooo_start)) : null, u.ooo_end ? E('Settings:EndTime', it.isoMs(u.ooo_end)) : null,
        msg('Settings:AppliesToInternal'), msg('Settings:AppliesToExternalKnown'), msg('Settings:AppliesToExternalUnknown')])]));
    }
    const oofSet = child(oof, 'Settings:Set');
    if (oofSet) {
      const state = Number(textOf(oofSet, 'Settings:OofState') || 0);
      const msgNode = kids(oofSet, 'Settings:OofMessage').find((m) => child(m, 'Settings:AppliesToInternal')) || child(oofSet, 'Settings:OofMessage');
      const reply = textOf(msgNode, 'Settings:ReplyMessage');
      const start = state === 2 ? it.parseTime(textOf(oofSet, 'Settings:StartTime')) : null;
      const end = state === 2 ? it.parseTime(textOf(oofSet, 'Settings:EndTime')) : null;
      db.prepare('UPDATE users SET ooo_enabled = ?, ooo_message = COALESCE(?, ooo_message), ooo_start = ?, ooo_end = ? WHERE id = ?')
        .run(state ? 1 : 0, reply ?? null, start ? start.toISOString() : null, end ? end.toISOString() : null, u.id);
      out.push(E('Settings:Oof', [E('Settings:Status', 1)]));
    }
    const devInfo = child(child(p, 'Settings:DeviceInformation'), 'Settings:Set');
    if (devInfo) { saveDeviceInfo(req.device, devInfo); out.push(E('Settings:DeviceInformation', [E('Settings:Status', 1)])); }
    if (child(p, 'Settings:DevicePassword')) out.push(E('Settings:DevicePassword', [E('Settings:Status', 1)]));
    if (child(p, 'Settings:UserInformation')) {
      const addrs = [u.email];
      out.push(E('Settings:UserInformation', [E('Settings:Status', 1), E('Settings:Get', parseFloat(req.eas.version) >= 14.1
        ? [E('Settings:Accounts', [E('Settings:Account', [E('Settings:UserDisplayName', u.name || u.email), E('Settings:EmailAddresses', [E('Settings:PrimarySmtpAddress', u.email), ...addrs.map((a) => E('Settings:SmtpAddress', a))])])])]
        : [E('Settings:EmailAddresses', addrs.map((a) => E('Settings:SmtpAddress', a)))])]));
    }
    send(res, E('Settings:Settings', out));
  },
};

// ------------------------------------------------------------ Sync for one collection
async function syncCollection(req, c, globalWindow) {
  const dev = req.device;
  const u = req.user;
  const key = textOf(c, 'AirSync:SyncKey') ?? '0';
  const id = textOf(c, 'AirSync:CollectionId');
  const coll = collection(dev.user_id, id);
  const head = (status, k) => [E('AirSync:SyncKey', k ?? key), E('AirSync:CollectionId', id || ''), E('AirSync:Status', status)];
  if (!coll) return { node: E('AirSync:Collection', head(8)) };
  let row = getState(dev, id);
  const options = readOptions(child(c, 'AirSync:Options'), row?.options_json ? JSON.parse(row.options_json) : null);
  if (key === '0') {
    putState(dev, id, 1, {}, 0, null, options);
    return { node: E('AirSync:Collection', head(1, 1)), changed: true };
  }
  const base = stateForKey(row, key);
  if (!base) return { node: E('AirSync:Collection', head(3, 0)) };
  const state = { ...base };
  const clients = (row.prev_key === Number(key) ? JSON.parse(row.state_json)._clients : null) || {};
  const responses = [];

  // 1. What the phone changed
  const cmds = child(c, 'AirSync:Commands');
  for (const cmd of cmds?.children || []) {
    const sid = textOf(cmd, 'AirSync:ServerId');
    const app = child(cmd, 'AirSync:ApplicationData');
    try {
      if (cmd.tag === 'AirSync:Add') {
        const cid = textOf(cmd, 'AirSync:ClientId');
        if (clients[cid]) { responses.push(E('AirSync:Add', [E('AirSync:ClientId', cid), E('AirSync:ServerId', clients[cid]), E('AirSync:Status', 1)])); continue; }
        let newSid = null;
        if (coll.kind === 'calendar') newSid = `cal:${(await cal.createEvent(u, it.readEvent(app))).id}`;
        else if (coll.kind === 'contacts') newSid = `con:${it.saveContact(u.id, app)}`;
        else if (coll.kind === 'tasks') newSid = `task:${it.saveTask(u.id, app)}`;
        if (!newSid) { responses.push(E('AirSync:Add', [E('AirSync:ClientId', cid), E('AirSync:Status', 6)])); continue; }
        clients[cid] = newSid;
        responses.push(E('AirSync:Add', [E('AirSync:ClientId', cid), E('AirSync:ServerId', newSid), E('AirSync:Status', 1)]));
      } else if (cmd.tag === 'AirSync:Change') {
        const iid = itemId(sid);
        let ok = true;
        if (coll.kind === 'mail') ok = !!it.applyMailChange(u.id, iid, app);
        else if (coll.kind === 'calendar') {
          const ev = cal.getEvent(u.id, iid);
          if (!ev) ok = false;
          else if (ev.my_status === 'organizer') await cal.updateEvent(u, iid, it.readEvent(app));
          else await cal.updateEvent(u, iid, { reminder_minutes: it.readEvent(app).reminder_minutes });
        } else if (coll.kind === 'contacts') ok = !!db.prepare('SELECT 1 FROM contacts WHERE id = ? AND user_id = ? AND is_saved = 1').get(iid, u.id) && !!it.saveContact(u.id, app, iid);
        else ok = !!db.prepare('SELECT 1 FROM tasks WHERE id = ? AND user_id = ?').get(iid, u.id) && !!it.saveTask(u.id, app, iid);
        if (!ok) { responses.push(E('AirSync:Change', [E('AirSync:ServerId', sid), E('AirSync:Status', 8)])); delete state[sid]; continue; }
        const cur = currentItems(u.id, coll, options).get(sid);
        if (cur) state[sid] = cur;
      } else if (cmd.tag === 'AirSync:Delete') {
        const iid = itemId(sid);
        if (coll.kind === 'mail') {
          const asMoves = textOf(c, 'AirSync:DeletesAsMoves') !== '0';
          const m = store.getMessage(u.id, iid);
          if (m && m.folder_id === coll.folder.id) { if (asMoves) store.deleteMessage(u.id, iid); else store.purgeMessage(iid); }
        } else if (coll.kind === 'calendar') { if (cal.getEvent(u.id, iid)) await cal.deleteEvent(u, iid); }
        else if (coll.kind === 'contacts') db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(iid, u.id);
        else db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(iid, u.id);
        delete state[sid];
      } else if (cmd.tag === 'AirSync:Fetch') {
        const data = await itemData(u.id, coll, sid, options);
        responses.push(E('AirSync:Fetch', data ? [E('AirSync:ServerId', sid), E('AirSync:Status', 1), E('AirSync:ApplicationData', data)] : [E('AirSync:ServerId', sid), E('AirSync:Status', 8)]));
      }
    } catch (e) {
      console.warn('[eas] sync command failed:', e.message);
      const tag = cmd.tag === 'AirSync:Add' ? 'AirSync:Add' : cmd.tag;
      responses.push(E(tag, [cmd.tag === 'AirSync:Add' ? E('AirSync:ClientId', textOf(cmd, 'AirSync:ClientId')) : E('AirSync:ServerId', sid || ''), E('AirSync:Status', e.status === 400 ? 6 : 5)]));
    }
  }
  // Items the phone itself created are already on the phone
  for (const s of Object.values(clients)) { const v = currentItems(u.id, coll, options).get(s); if (v) state[s] = v; }

  // 2. What changed on the server since that key
  const getChanges = textOf(c, 'AirSync:GetChanges') !== '0';
  const window = Math.min(512, Number(textOf(c, 'AirSync:WindowSize') || globalWindow || 100)) || 100;
  const commands = [];
  let more = false;
  if (getChanges) {
    const changes = diff(state, currentItems(u.id, coll, options));
    more = changes.length > window;
    for (const ch of changes.slice(0, window)) {
      if (ch.op === 'Delete') { commands.push(E('AirSync:Delete', [E('AirSync:ServerId', ch.sid)])); delete state[ch.sid]; continue; }
      const data = await itemData(u.id, coll, ch.sid, options);
      if (!data) continue;
      commands.push(E(`AirSync:${ch.op}`, [E('AirSync:ServerId', ch.sid), E('AirSync:ApplicationData', data)]));
      state[ch.sid] = ch.ver;
    }
  }
  const replay = Number(key) !== row.sync_key;
  if (!replay && !commands.length && !responses.length) {
    // Nothing new: keep the key (an empty long-poll answer must not move it)
    if (child(c, 'AirSync:Options')) db.prepare('UPDATE eas_state SET options_json = ? WHERE id = ?').run(JSON.stringify(options), row.id);
    return { changed: false, node: E('AirSync:Collection', head(1, key)) };
  }
  // A repeated key (the phone lost our answer) gets the same new key again
  const next = replay ? row.sync_key : newKey(row);
  putState(dev, id, next, { ...state, _clients: clients }, Number(key), base, child(c, 'AirSync:Options') ? options : null);
  return {
    changed: commands.length > 0 || responses.length > 0,
    node: E('AirSync:Collection', [...head(1, next), more ? E('AirSync:MoreAvailable') : null,
      commands.length ? E('AirSync:Commands', commands) : null, responses.length ? E('AirSync:Responses', responses) : null]),
  };
}

// ------------------------------------------------------------ folders
function folderOp(req, res, op) {
  const dev = req.device;
  const p = req.wbxml;
  const root = { create: 'FolderHierarchy:FolderCreate', delete: 'FolderHierarchy:FolderDelete', update: 'FolderHierarchy:FolderUpdate' }[op];
  const key = textOf(p, 'FolderHierarchy:SyncKey');
  const row = getState(dev, '_folders');
  const base = stateForKey(row, key);
  if (!base) return send(res, E(root, [E('FolderHierarchy:Status', 9)]));
  const name = String(textOf(p, 'FolderHierarchy:DisplayName') || '').trim();
  const sid = textOf(p, 'FolderHierarchy:ServerId');
  let status = 1; let newId = null;
  try {
    if (op === 'create') {
      const type = Number(textOf(p, 'FolderHierarchy:Type') || 12);
      if (type !== 12 && type !== 1) status = 10;
      else if (!name) status = 10;
      else if (store.listFolders(dev.user_id).some((f) => f.name.toLowerCase() === name.toLowerCase())) status = 2;
      else newId = `f${store.createFolder(dev.user_id, name).id}`;
    } else {
      const coll = collection(dev.user_id, sid);
      if (!coll) status = 4;
      else if (coll.kind !== 'mail' || coll.folder.role) status = 3;
      else if (op === 'delete') store.deleteFolder(dev.user_id, coll.folder.id);
      else if (!name) status = 10;
      else store.renameFolder(dev.user_id, coll.folder.id, name);
    }
  } catch (e) { status = e.status === 409 ? 2 : 6; }
  if (status !== 1) return send(res, E(root, [E('FolderHierarchy:Status', status)]));
  // Record the change as known to the phone so the next FolderSync does not repeat it
  const state = { ...base };
  const now = new Map(folderList(dev.user_id).map((f) => [f.id, `${f.name}|${f.type}`]));
  if (op === 'create') state[newId] = now.get(newId);
  if (op === 'update') state[sid] = now.get(sid);
  if (op === 'delete') delete state[sid];
  const next = newKey(row);
  putState(dev, '_folders', next, state, Number(key), base);
  send(res, E(root, [E('FolderHierarchy:Status', 1), E('FolderHierarchy:SyncKey', next), newId ? E('FolderHierarchy:ServerId', newId) : null]));
}

// ------------------------------------------------------------ SendMail, SmartReply, SmartForward
async function compose(req, res, mode) {
  const u = req.user;
  let mime; let src = {};
  if (req.wbxml) {
    const root = req.wbxml;
    mime = child(root, 'ComposeMail:Mime')?.opaque || Buffer.from(textOf(root, 'ComposeMail:Mime') || '');
    const s = child(root, 'ComposeMail:Source');
    if (s) src = { folderId: textOf(s, 'ComposeMail:FolderId'), itemId: textOf(s, 'ComposeMail:ItemId') || textOf(s, 'ComposeMail:LongId') };
    if (child(root, 'ComposeMail:ReplaceMime')) mode = 'send';
  } else {
    mime = req.body;
    src = { folderId: req.eas.params.CollectionId, itemId: req.eas.params.ItemId };
  }
  // Arzio always keeps a copy in Sent Items (SaveInSentItems is not needed)
  if (!mime?.length) return fail(req, res, 103, 400);
  const parsed = await simpleParser(mime);
  const list = (v) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x) => x.value || []) : []).filter((a) => a.address).map((a) => ({ address: a.address.toLowerCase(), name: a.name || '' }));
  const input = {
    from: list(parsed.from)[0]?.address || undefined,
    to: list(parsed.to), cc: list(parsed.cc), bcc: list(parsed.bcc),
    subject: parsed.subject || '', text: parsed.text || '', html: typeof parsed.html === 'string' ? parsed.html : undefined,
    inReplyTo: parsed.inReplyTo || undefined, references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || undefined,
    attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || 'attachment', contentType: a.contentType, contentBase64: a.content.toString('base64') })),
    noSignature: true,
  };
  if (input.from && !input.from.includes('@')) delete input.from;
  if (mode !== 'send' && src.itemId) {
    const orig = store.getMessage(u.id, itemId(src.itemId.includes(':') ? src.itemId : `x:${src.itemId}`));
    if (orig) {
      const head = `\n\n-------- ${mode === 'reply' ? 'Original message' : 'Forwarded message'} --------\nFrom: ${orig.from_name ? `${orig.from_name} <${orig.from_addr}>` : orig.from_addr}\nDate: ${new Date(orig.date).toUTCString()}\nSubject: ${orig.subject}\n\n`;
      const origText = orig.text_body || store.htmlToText(orig.html_body || '');
      input.text = `${input.text}${head}${mode === 'reply' ? origText.split('\n').map((l) => `> ${l}`).join('\n') : origText}`;
      if (input.html) input.html = `${input.html}<br><hr><div>${head.trim().replace(/\n/g, '<br>')}</div><blockquote>${orig.html_body || origText.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).replace(/\n/g, '<br>')}</blockquote>`;
      if (mode === 'reply') { input.inReplyTo = input.inReplyTo || orig.message_id || undefined; input.references = input.references || [orig.refs, orig.message_id].filter(Boolean).join(' ') || undefined; }
      if (mode === 'forward') {
        for (const a of orig.attachments) {
          const f = it.attachmentFor(u.id, `att:${a.id}`);
          if (f?.data) input.attachments.push({ filename: a.filename, contentType: a.content_type, contentBase64: f.data.toString('base64') });
        }
      }
    }
  }
  try {
    await sendMail({ ...u, undo_send_seconds: 0 }, input);
  } catch (e) {
    console.warn('[eas] send failed:', e.message);
    return fail(req, res, e.status === 429 ? 113 : e.status === 403 ? 119 : 120, 500);
  }
  res.status(200).end();
}

// ------------------------------------------------------------ devices
function saveDeviceInfo(dev, info) {
  db.prepare('UPDATE eas_devices SET model = ?, friendly_name = ?, os = ? WHERE id = ?').run(
    String(textOf(info, 'Settings:Model') || dev.model || '').slice(0, 100), String(textOf(info, 'Settings:FriendlyName') || dev.friendly_name || '').slice(0, 100),
    String(textOf(info, 'Settings:OS') || dev.os || '').slice(0, 100), dev.id);
}
function policyDoc() {
  const p = REQUIRE_PASSCODE;
  return [
    E('Provision:DevicePasswordEnabled', p ? 1 : 0), E('Provision:AlphanumericDevicePasswordRequired', 0), E('Provision:PasswordRecoveryEnabled', 0),
    E('Provision:RequireStorageCardEncryption', 0), E('Provision:AttachmentsEnabled', 1), E('Provision:MinDevicePasswordLength', p || 1),
    E('Provision:MaxInactivityTimeDeviceLock', p ? 900 : 9999), E('Provision:MaxDevicePasswordFailedAttempts', p ? 10 : 16), E('Provision:MaxAttachmentSize'),
    E('Provision:AllowSimpleDevicePassword', 1), E('Provision:DevicePasswordExpiration'), E('Provision:DevicePasswordHistory', 0),
    E('Provision:AllowStorageCard', 1), E('Provision:AllowCamera', 1), E('Provision:RequireDeviceEncryption', 0), E('Provision:AllowUnsignedApplications', 1),
    E('Provision:AllowUnsignedInstallationPackages', 1), E('Provision:MinDevicePasswordComplexCharacters', 1), E('Provision:AllowWiFi', 1),
    E('Provision:AllowTextMessaging', 1), E('Provision:AllowPOPIMAPEmail', 1), E('Provision:AllowBluetooth', 2), E('Provision:AllowIrDA', 1),
    E('Provision:RequireManualSyncWhenRoaming', 0), E('Provision:AllowDesktopSync', 1), E('Provision:MaxCalendarAgeFilter', 0), E('Provision:AllowHTMLEmail', 1),
    E('Provision:MaxEmailAgeFilter', 0), E('Provision:MaxEmailBodyTruncationSize', -1), E('Provision:MaxEmailHTMLBodyTruncationSize', -1),
    E('Provision:RequireSignedSMIMEMessages', 0), E('Provision:RequireEncryptedSMIMEMessages', 0), E('Provision:RequireSignedSMIMEAlgorithm', 0),
    E('Provision:RequireEncryptionSMIMEAlgorithm', 0), E('Provision:AllowSMIMEEncryptionAlgorithmNegotiation', 2), E('Provision:AllowSMIMESoftCerts', 1),
    E('Provision:AllowBrowser', 1), E('Provision:AllowConsumerEmail', 1), E('Provision:AllowRemoteDesktop', 1), E('Provision:AllowInternetSharing', 1),
  ];
}

/** Devices for the Settings page */
export function listDevices(userId) {
  return db.prepare('SELECT id, device_id, device_type, model, friendly_name, os, user_agent, protocol, status, first_seen, last_seen, wiped_at FROM eas_devices WHERE user_id = ? ORDER BY last_seen DESC').all(userId);
}
export function setDeviceStatus(userId, id, status) {
  const d = db.prepare('SELECT * FROM eas_devices WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!d) return null;
  if (status === 'remove') db.prepare('DELETE FROM eas_devices WHERE id = ?').run(d.id);
  else db.prepare('UPDATE eas_devices SET status = ? WHERE id = ?').run(status, d.id);
  waiters.get(d.id)?.();
  audit(userId, `security.device.${status}`, { deviceId: d.device_id, model: d.model || d.device_type });
  return true;
}

// ------------------------------------------------------------ Autodiscover
const xmlEsc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function autodiscover(req, res) {
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const email = /<EMailAddress>\s*([^<\s]+)\s*<\/EMailAddress>/i.exec(body)?.[1] || req.user.email;
  const schema = /<AcceptableResponseSchema>\s*([^<\s]+)\s*</i.exec(body)?.[1] || '';
  const base = `https://${req.get('host')}`;
  res.type('text/xml; charset=utf-8');
  if (/mobilesync/i.test(schema) || !schema) {
    return res.send(`<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006">
    <Culture>en:us</Culture>
    <User><DisplayName>${xmlEsc(req.user.name)}</DisplayName><EMailAddress>${xmlEsc(email)}</EMailAddress></User>
    <Action><Settings><Server><Type>MobileSync</Type><Url>${base}/Microsoft-Server-ActiveSync</Url><Name>${base}/Microsoft-Server-ActiveSync</Name></Server></Settings></Action>
  </Response>
</Autodiscover>`);
  }
  // Outlook for Windows/Mac: IMAP and SMTP settings
  const host = config.imap?.publicHost || req.hostname;
  res.send(`<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <User><DisplayName>${xmlEsc(req.user.name)}</DisplayName></User>
    <Account><AccountType>email</AccountType><Action>settings</Action>
      <Protocol><Type>IMAP</Type><Server>${xmlEsc(host)}</Server><Port>993</Port><LoginName>${xmlEsc(email)}</LoginName><SSL>on</SSL><SPA>off</SPA><AuthRequired>on</AuthRequired></Protocol>
      <Protocol><Type>SMTP</Type><Server>${xmlEsc(host)}</Server><Port>465</Port><LoginName>${xmlEsc(email)}</LoginName><SSL>on</SSL><SPA>off</SPA><AuthRequired>on</AuthRequired><UsePOPAuth>on</UsePOPAuth></Protocol>
    </Account>
  </Response>
</Autodiscover>`);
}
eas.post(/^\/autodiscover\/autodiscover\.xml$/i, auth, autodiscover);
eas.get(/^\/autodiscover\/autodiscover\.xml$/i, auth, autodiscover);
