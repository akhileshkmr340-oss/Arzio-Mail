// Arzio Mail server entry point: HTTP API + web client + inbound SMTP.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ensurePublicTenant } from './db.js';
import { api } from './routes/api.js';
import { startInboundSmtp } from './mail/smtp-inbound.js';
import { aiInfo } from './ai/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
ensurePublicTenant(config.primaryDomain, config.serviceName);

export const app = express();
if (config.http.trustProxy) app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'");
  next();
});

// Simple CSRF defence for cookie auth: state-changing API calls must be JSON
// (browsers cannot send cross-site JSON without a CORS preflight).
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.path.startsWith('/inbound/')) {
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send requests as application/json.' });
    }
  }
  next();
});
app.use('/api', express.json({ limit: Math.ceil((config.quotas.maxMessageBytes * 1.4) / 1024 / 1024) + 'mb' }));
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(here, '..', 'public'), { index: 'index.html' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(here, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.expose && status !== 502 ? 'Something went wrong.' : err.message });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(config.http.port, config.http.host, () => {
    console.log(`${config.serviceName} web on http://localhost:${config.http.port}  (domain: ${config.primaryDomain})`);
    console.log(`[ai] provider: ${aiInfo().provider}${aiInfo().model ? ` (${aiInfo().model})` : ''}  [outbound] ${config.outbound.transport}`);
  });
  if (config.inbound.smtpEnabled) startInboundSmtp();
}
