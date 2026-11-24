// Push notifications to the Arzio phone app (Expo push service, which passes
// them on to Apple and Google). Phones register their token after sign-in.
//
// ARZIO_PUSH=off turns it off. ARZIO_PUSH_PREVIEW chooses what the lock screen
// shows: "full" (sender and subject, the default), "sender" or "none".
import { db } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS push_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used TEXT
);
`);

const env = process.env;
const enabled = () => !/^(off|false|0|no)$/i.test(env.ARZIO_PUSH || '');
const endpoint = () => env.ARZIO_PUSH_URL || 'https://exp.host/--/api/v2/push/send';
const preview = () => (['full', 'sender', 'none'].includes(env.ARZIO_PUSH_PREVIEW) ? env.ARZIO_PUSH_PREVIEW : 'full');
const VALID = /^(ExponentPushToken|ExpoPushToken)\[[\w-]{10,100}\]$/;

export function registerToken(userId, { token, platform, deviceName }) {
  if (!VALID.test(String(token || ''))) throw Object.assign(new Error('That is not a push token.'), { status: 400 });
  db.prepare(`INSERT INTO push_tokens (user_id, token, platform, device_name) VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, device_name = excluded.device_name`)
    .run(userId, token, String(platform || '').slice(0, 20), String(deviceName || '').slice(0, 80));
}
export function removeToken(userId, token) {
  db.prepare('DELETE FROM push_tokens WHERE user_id = ? AND token = ?').run(userId, String(token || ''));
}
export const listTokens = (userId) => db.prepare('SELECT id, platform, device_name, created_at, last_used FROM push_tokens WHERE user_id = ? ORDER BY id DESC').all(userId);

/** Sends to every phone of the user. Never throws: push is best effort. */
export async function pushToUser(userId, { title, body = '', data = {}, kind = 'mail' }) {
  if (!enabled()) return 0;
  const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(userId).map((r) => r.token);
  if (!tokens.length) return 0;
  const p = preview();
  const shown = kind === 'mail' ? (p === 'none' ? { title: 'New message', body: '' } : p === 'sender' ? { title, body: 'New message' } : { title, body }) : { title, body };
  const messages = tokens.map((to) => ({ to, title: shown.title.slice(0, 120), body: shown.body.slice(0, 200), data, sound: 'default', channelId: kind, priority: 'high' }));
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}) },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(10000),
    });
    const out = await res.json().catch(() => ({}));
    (out.data || []).forEach((ticket, i) => {
      // The app was removed or the token replaced: forget it
      if (ticket?.details?.error === 'DeviceNotRegistered') db.prepare('DELETE FROM push_tokens WHERE token = ?').run(tokens[i]);
    });
    db.prepare("UPDATE push_tokens SET last_used = datetime('now') WHERE user_id = ?").run(userId);
    return messages.length;
  } catch (e) {
    console.warn('[push]', e.message);
    return 0;
  }
}
