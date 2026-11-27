// ARZIO_SIGNUP_MAX_USERS: a private server closes sign-up after the owner's account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-signup-'));
Object.assign(process.env, { ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log', ARZIO_SIGNUP_MAX_USERS: '1' });
const { app } = await import('../src/server.js');

test('sign-up closes once the first account exists', async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await (await fetch(`${base}/service`)).json()).signupOpen, true);
  assert.equal((await post('/auth/signup', { username: 'owner', name: 'Owner', password: 'password123' })).status, 201);
  assert.equal((await (await fetch(`${base}/service`)).json()).signupOpen, false);
  const r = await post('/auth/signup', { username: 'stranger', name: 'Stranger', password: 'password123' });
  assert.equal(r.status, 403);
  server.close();
});
