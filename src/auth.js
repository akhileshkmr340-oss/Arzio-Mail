// Accounts and sessions: scrypt password hashing, random session tokens in an
// HttpOnly cookie.
import crypto from 'node:crypto';
import { db, SYSTEM_FOLDERS, tx, ensurePublicTenant } from './db.js';
import { config } from './config.js';
import { verifyTotp } from './mfa.js';

const SESSION_DAYS = 30;
export const COOKIE = 'arzio_session';
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/;
const RESERVED = new Set(['admin', 'administrator', 'postmaster', 'abuse', 'root', 'support', 'security',
  'noreply', 'no-reply', 'mailer-daemon', 'hostmaster', 'webmaster', 'info', 'help', 'billing']);

export function validateUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return { error: 'Username must be 3 to 32 characters: letters, numbers, dots, dashes or underscores.' };
  if (/[._-]{2}/.test(u)) return { error: 'Username cannot contain two symbols in a row.' };
  if (RESERVED.has(u)) return { error: 'That username is reserved.' };
  return { username: u };
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

/**
 * Create a mailbox user.
 * - Public signup: no orgId -> the public tenant, address on the public domain.
 * - Private tenant: orgId + domain (must be a verified domain of that org).
 */
export function createUser({ username, name, password, ip, orgId, domain, role = 'user', isAdmin = false, allowUnverified = false }) {
  const v = validateUsername(username);
  if (v.error) throw httpError(400, v.error);
  const pwErr = validatePassword(password);
  if (pwErr) throw httpError(400, pwErr);

  let org;
  let dom;
  if (orgId) {
    org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    dom = db.prepare('SELECT * FROM domains WHERE name = ? AND org_id = ?').get(String(domain || '').toLowerCase(), orgId);
    if (!org || !dom) throw httpError(400, 'That domain does not belong to this organization.');
    if (!dom.verified && !allowUnverified) throw httpError(400, 'Verify the domain before adding users to it.');
    if (org.kind === 'private' && org.max_users > 0) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE org_id = ?').get(org.id).n;
      if (n >= org.max_users) throw httpError(400, `This organization has reached its limit of ${org.max_users} users.`);
    }
  } else {
    org = ensurePublicTenant(config.primaryDomain, config.serviceName);
    dom = { name: config.primaryDomain };
  }

  const email = `${v.username}@${dom.name}`;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw httpError(409, 'That address is already taken.');
  const displayName = String(name || v.username).trim().slice(0, 100) || v.username;
  return tx(() => {
    const r = db.prepare('INSERT INTO users (org_id, role, email, name, password_hash, is_admin, signup_ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(org.id, role === 'org_admin' ? 'org_admin' : 'user', email, displayName, hashPassword(password), isAdmin || config.adminEmails.includes(email) ? 1 : 0, ip || null);
    const userId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO folders (user_id, name, role) VALUES (?, ?, ?)');
    for (const [fname, frole] of SYSTEM_FOLDERS) ins.run(userId, fname, frole);
    return getUser(userId);
  });
}

export function getUser(id) {
  return db.prepare('SELECT u.id, u.org_id, u.role, u.email, u.name, u.is_admin, u.is_disabled, u.ai_enabled, u.signature, u.created_at, u.totp_enabled, u.ooo_enabled, u.ooo_subject, u.ooo_message, u.ooo_start, u.ooo_end, u.undo_send_seconds, u.focused_inbox, o.name AS org_name, o.kind AS org_kind FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = ?').get(id);
}

export function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export function login(emailOrUser, password, totpCode) {
  let email = String(emailOrUser || '').trim().toLowerCase();
  if (!email.includes('@')) email = `${email}@${config.primaryDomain}`;
  const u = findUserByEmail(email);
  // Always run scrypt so response time does not reveal whether the account exists
  const ok = verifyPassword(String(password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) throw httpError(401, 'Wrong email or password.');
  if (u.is_disabled) throw httpError(403, 'This account is disabled.');
  if (u.mailbox_type === 'shared') throw httpError(403, 'Shared mailboxes cannot sign in. Open them from your own account.');
  if (u.totp_enabled) {
    if (!totpCode) throw Object.assign(httpError(401, 'Enter the 6-digit code from your authenticator app.'), { mfaRequired: true });
    if (!verifyTotp(u.totp_secret, totpCode)) throw Object.assign(httpError(401, 'That code is not valid. Try the latest code.'), { mfaRequired: true });
  }
  return createSession(u.id);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expires, userId };
}

export function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!s || s.expires_at < new Date().toISOString()) return null;
  const u = getUser(s.user_id);
  return u && !u.is_disabled ? u : null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, expires) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${new Date(expires).toUTCString()}`];
  if (config.http.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

// ------------------------------------------------------------ API tokens and app passwords

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Personal access token for the REST API and the MCP server. Shown once. */
export function createApiToken(userId, name, scopes = 'read') {
  const token = `arz_${crypto.randomBytes(24).toString('base64url')}`;
  const sc = scopes === 'read,send' ? 'read,send' : 'read';
  const r = db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes) VALUES (?, ?, ?, ?)').run(userId, String(name || 'Token').slice(0, 80), sha256(token), sc);
  return { id: Number(r.lastInsertRowid), token, scopes: sc };
}

export function userFromApiToken(token) {
  if (!/^arz_[A-Za-z0-9_-]{20,}$/.test(String(token || ''))) return null;
  const t = db.prepare('SELECT id, user_id, scopes FROM api_tokens WHERE token_hash = ?').get(sha256(token));
  if (!t) return null;
  const u = getUser(t.user_id);
  if (!u || u.is_disabled) return null;
  db.prepare("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?").run(t.id);
  return { user: u, scopes: t.scopes.split(',') };
}

/** App password for desktop and phone mail apps (IMAP/SMTP). 16 letters, shown once. */
export function createAppPassword(userId, name) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz';
  const bytes = crypto.randomBytes(16);
  const pw = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  const r = db.prepare('INSERT INTO app_passwords (user_id, name, password_hash) VALUES (?, ?, ?)').run(userId, String(name || 'Mail app').slice(0, 80), sha256(pw));
  return { id: Number(r.lastInsertRowid), password: pw.replace(/(.{4})(?=.)/g, '$1 ') };
}

/**
 * Sign-in for IMAP and SMTP submission. Accepts an app password, or the account
 * password when two-step verification is off. Returns the user or null.
 */
export function clientLogin(emailOrUser, password) {
  let email = String(emailOrUser || '').trim().toLowerCase();
  if (!email.includes('@')) email = `${email}@${config.primaryDomain}`;
  const u = findUserByEmail(email);
  const pw = String(password || '');
  if (!u || u.is_disabled || u.mailbox_type === 'shared') { verifyPassword(pw, DUMMY_HASH); return null; }
  const app = db.prepare('SELECT id FROM app_passwords WHERE user_id = ? AND password_hash = ?').get(u.id, sha256(pw.replace(/\s+/g, '')));
  if (app) {
    db.prepare("UPDATE app_passwords SET last_used = datetime('now') WHERE id = ?").run(app.id);
    return getUser(u.id);
  }
  if (!u.totp_enabled && verifyPassword(pw, u.password_hash)) return getUser(u.id);
  return null;
}

export function requireAuth(req, res, next) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) {
    const t = userFromApiToken(bearer);
    if (!t) return res.status(401).json({ error: 'That API token is not valid.' });
    // Read-only tokens may only read; tokens never manage the account itself
    if (req.method !== 'GET' && !t.scopes.includes('send')) return res.status(403).json({ error: 'This token is read-only.' });
    if (/^\/(me|org|admin)(\/|$)/.test(req.path) && req.method !== 'GET') return res.status(403).json({ error: 'API tokens cannot change account settings.' });
    req.user = t.user;
    req.tokenScopes = t.scopes;
    return next();
  }
  const user = userFromToken(parseCookies(req.headers.cookie)[COOKIE]);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  req.user = user;
  next();
}

// Service operator (superadmin): manages tenants across the whole service
export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Service admins only.' });
  next();
}

// Organization admin of a private tenant (superadmins pass too)
export function requireOrgAdmin(req, res, next) {
  const u = req.user;
  if (!u) return res.status(401).json({ error: 'Please sign in.' });
  if (u.is_admin || (u.role === 'org_admin' && u.org_kind === 'private')) return next();
  return res.status(403).json({ error: 'Organization admins only.' });
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
