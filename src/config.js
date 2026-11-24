// Central configuration. Everything is driven by environment variables so the
// same build runs in development and production.
import path from 'node:path';

const env = process.env;
const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

// Public demo mode: no mail leaves or enters the server from the internet,
// only the web app runs, and a shared demo account with sample data is made.
export const demo = /^(1|true|yes|on)$/i.test(env.ARZIO_DEMO || '');
if (demo) {
  env.OUTBOUND_TRANSPORT = 'log';
  env.INBOUND_SMTP_ENABLED = 'false';
  env.IMAP_ENABLED = 'false';
  env.SUBMISSION_ENABLED = 'false';
  env.ARZIO_BILLING = 'off';
}

export const config = {
  demo: demo ? { user: (env.ARZIO_DEMO_USER || 'demo').toLowerCase(), password: env.ARZIO_DEMO_PASSWORD || 'ArzioDemo2026' } : null,
  // Public service identity
  serviceName: env.ARZIO_SERVICE_NAME || 'Arzio Mail',
  // Domain users sign up under, e.g. arzio.com -> alice@arzio.com
  primaryDomain: (env.ARZIO_DOMAIN || 'arzio.local').toLowerCase(),
  // Extra domains this server accepts mail for (comma separated)
  extraDomains: (env.ARZIO_EXTRA_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),

  // Service operators (superadmins) who can create private organizations
  adminEmails: (env.ARZIO_ADMIN_EMAILS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),

  http: {
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    // Set true behind HTTPS so session cookies get the Secure flag
    secureCookies: bool(env.SECURE_COOKIES, false),
    trustProxy: bool(env.TRUST_PROXY, false),
  },

  dataDir: path.resolve(env.ARZIO_DATA_DIR || './data'),

  signup: {
    open: bool(env.ARZIO_SIGNUP_OPEN, true),
    // Max accounts created per IP per hour (basic abuse control)
    perIpPerHour: Number(env.ARZIO_SIGNUP_PER_IP_PER_HOUR || 5),
  },

  quotas: {
    mailboxBytes: Number(env.ARZIO_MAILBOX_QUOTA_MB || 1024) * 1024 * 1024,
    maxMessageBytes: Number(env.ARZIO_MAX_MESSAGE_MB || 25) * 1024 * 1024,
    sendsPerUserPerDay: Number(env.ARZIO_SENDS_PER_DAY || 500),
  },

  inbound: {
    // Built-in SMTP server that receives mail for your domains (point MX here)
    smtpEnabled: bool(env.INBOUND_SMTP_ENABLED, true),
    smtpPort: Number(env.INBOUND_SMTP_PORT || 2525), // use 25 in production
    smtpHost: env.INBOUND_SMTP_HOST || '0.0.0.0',
    tlsKey: env.INBOUND_TLS_KEY || '',
    tlsCert: env.INBOUND_TLS_CERT || '',
    // Shared secret for the HTTP inbound webhook (/api/inbound/*)
    webhookSecret: env.INBOUND_WEBHOOK_SECRET || '',
  },

  // Desktop and phone mail apps (Outlook, Apple Mail, Thunderbird, Gmail app...)
  imap: {
    enabled: bool(env.IMAP_ENABLED, true),
    port: Number(env.IMAP_PORT || 1143), // use 993 with TLS in production
    host: env.IMAP_HOST || '0.0.0.0',
    tls: bool(env.IMAP_TLS, false),
    tlsKey: env.MAIL_TLS_KEY || env.INBOUND_TLS_KEY || '',
    tlsCert: env.MAIL_TLS_CERT || env.INBOUND_TLS_CERT || '',
    // Host name shown to users in mail app setup
    publicHost: env.MAIL_PUBLIC_HOST || `mail.${(env.ARZIO_DOMAIN || 'arzio.local').toLowerCase()}`,
  },
  submission: {
    enabled: bool(env.SUBMISSION_ENABLED, true),
    port: Number(env.SUBMISSION_PORT || 1587), // use 465 (TLS) or 587 (STARTTLS) in production
    host: env.SUBMISSION_HOST || '0.0.0.0',
    tls: bool(env.SUBMISSION_TLS, false),
  },

  outbound: {
    // relay = SMTP relay such as Amazon SES or Postmark (recommended)
    // log   = development: write outgoing mail to data/outbox instead of sending
    transport: env.OUTBOUND_TRANSPORT || 'log',
    smtp: {
      host: env.SMTP_RELAY_HOST || '',
      port: Number(env.SMTP_RELAY_PORT || 587),
      secure: bool(env.SMTP_RELAY_SECURE, false),
      user: env.SMTP_RELAY_USER || '',
      pass: env.SMTP_RELAY_PASS || '',
    },
    dkim: {
      selector: env.DKIM_SELECTOR || '',
      privateKeyPath: env.DKIM_PRIVATE_KEY_PATH || '',
    },
  },

  ai: {
    // anthropic | none   (none = built-in heuristic fallback, no external calls)
    provider: env.AI_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'none'),
    model: env.AI_MODEL || 'claude-opus-5-5',
    autoTriage: bool(env.AI_AUTO_TRIAGE, true),
  },
};

// Domains this server accepts mail for: the public domain, any extra static
// domains, plus verified tenant domains (checked in the domains table).
export async function isLocalDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (d === config.primaryDomain || config.extraDomains.includes(d)) return true;
  const { db } = await import('./db.js');
  return !!db.prepare('SELECT 1 FROM domains WHERE name = ? AND verified = 1').get(d);
}
