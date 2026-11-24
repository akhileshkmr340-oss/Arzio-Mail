// Inbound MX: receives mail from the internet for Arzio's domains.
// Point your domain's MX record at this server (port 25 in production).
import fs from 'node:fs';
import { SMTPServer } from 'smtp-server';
import { config } from '../config.js';
import { isLocalAddress, deliverRaw } from './delivery.js';

export function startInboundSmtp() {
  const opts = {
    name: config.primaryDomain,
    banner: `${config.serviceName} ESMTP`,
    authOptional: true,
    disabledCommands: ['AUTH'], // MX only; authenticated submission comes in Phase 3
    size: config.quotas.maxMessageBytes,
    logger: false,
    async onRcptTo(address, session, callback) {
      try {
        if (session.envelope.rcptTo.length >= 100) return callback(Object.assign(new Error('Too many recipients'), { responseCode: 452 }));
        if (!(await isLocalAddress(address.address))) {
          return callback(Object.assign(new Error('No such user here'), { responseCode: 550 }));
        }
        callback();
      } catch (e) {
        callback(Object.assign(new Error('Temporary failure'), { responseCode: 451 }));
      }
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        if (stream.sizeExceeded) return callback(Object.assign(new Error('Message too large'), { responseCode: 552 }));
        try {
          const raw = Buffer.concat(chunks);
          const delivered = await deliverRaw(raw, session.envelope.rcptTo.map((r) => r.address), {
            ip: session.remoteAddress, helo: session.hostNameAppearsAs, mailFrom: session.envelope.mailFrom?.address || '',
          });
          if (!delivered.length) return callback(Object.assign(new Error('Mailbox unavailable or full'), { responseCode: 452 }));
          callback(null, 'Message accepted');
        } catch (e) {
          console.error('[smtp] delivery failed', e);
          callback(Object.assign(new Error('Temporary failure, try again later'), { responseCode: 451 }));
        }
      });
    },
  };
  if (config.inbound.tlsKey && config.inbound.tlsCert) {
    opts.key = fs.readFileSync(config.inbound.tlsKey);
    opts.cert = fs.readFileSync(config.inbound.tlsCert);
  } else {
    opts.disabledCommands.push('STARTTLS');
  }
  const server = new SMTPServer(opts);
  server.on('error', (e) => console.error('[smtp] error', e.message));
  server.listen(config.inbound.smtpPort, config.inbound.smtpHost, () => {
    console.log(`[smtp] inbound MX listening on ${config.inbound.smtpHost}:${config.inbound.smtpPort}`);
  });
  return server;
}
