// Authenticated SMTP submission for desktop and phone mail apps.
// Sign in with your Arzio address and password (or an app password when
// two-step verification is on). Use port 465 (TLS) or 587 in production.
import fs from 'node:fs';
import { SMTPServer } from 'smtp-server';
import { config } from '../config.js';
import { clientLogin } from '../auth.js';
import { submitRaw } from './delivery.js';
import { audit } from '../audit.js';

const failures = new Map();

export function startSubmission() {
  const c = config.submission;
  const key = config.imap.tlsKey;
  const cert = config.imap.tlsCert;
  const opts = {
    name: config.imap.publicHost,
    banner: `${config.serviceName} submission`,
    secure: c.tls && !!(key && cert),
    authMethods: ['PLAIN', 'LOGIN'],
    // Without TLS (development only) allow AUTH on a plain connection
    allowInsecureAuth: !(key && cert),
    size: config.quotas.maxMessageBytes,
    logger: false,
    onAuth(auth, session, callback) {
      const ip = session.remoteAddress;
      const now = Date.now();
      const recent = (failures.get(ip) || []).filter((t) => now - t < 15 * 60e3);
      failures.set(ip, recent);
      if (recent.length >= 10) return callback(Object.assign(new Error('Too many failed sign-ins, try later'), { responseCode: 454 }));
      const user = clientLogin(auth.username, auth.password);
      if (!user) {
        recent.push(now);
        return setTimeout(() => callback(Object.assign(new Error('Authentication failed. With two-step verification on, use an app password.'), { responseCode: 535 })), 500);
      }
      audit(user.id, 'smtp.login', { ip });
      callback(null, { user });
    },
    onMailFrom(address, session, callback) {
      if (!session.user) return callback(Object.assign(new Error('Sign in first'), { responseCode: 530 }));
      callback();
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (ch) => chunks.push(ch));
      stream.on('end', async () => {
        if (stream.sizeExceeded) return callback(Object.assign(new Error('Message too large'), { responseCode: 552 }));
        try {
          await submitRaw(session.user, Buffer.concat(chunks), {
            from: session.envelope.mailFrom?.address || '',
            to: session.envelope.rcptTo.map((r) => r.address),
          });
          callback(null, 'Queued for delivery');
        } catch (e) {
          const code = e.status === 429 ? 451 : e.status >= 400 && e.status < 500 ? 550 : 451;
          callback(Object.assign(new Error(e.message), { responseCode: code }));
        }
      });
    },
  };
  if (key && cert) { opts.key = fs.readFileSync(key); opts.cert = fs.readFileSync(cert); } else opts.disabledCommands = ['STARTTLS'];
  const server = new SMTPServer(opts);
  server.on('error', (e) => console.error('[submission] error', e.message));
  server.listen(c.port, c.host, () => console.log(`[submission] SMTP AUTH listening on ${c.host}:${c.port}`));
  return server;
}
