# Arzio Mail (Phase 1)

Arzio Mail is a standalone email service, public and private like Outlook:

- **Public:** anyone can sign up for a free `name@arzio.com` address (Outlook.com / Gmail style).
- **Private:** organizations get their own tenant with custom domains (`name@company.com`), an organization admin console and user management (Microsoft 365 business style).

It has built-in AI (Claude by default): thread summaries with action items, reply and new-mail drafting, rewrite (improve, shorten, formal, friendly), and automatic inbox triage that drives the Focused / Other inbox.

## What Phase 1 includes

| Area | Features |
| --- | --- |
| Mail | Inbox, Drafts, Sent Items, Archive, Junk, Deleted Items, custom folders; compose, reply, reply all, forward; attachments; conversation threading; read/unread, flag, pin, categories; drag to folder; signatures |
| Inbox | Focused / Other tabs, AI priority and "needs reply" tags, flagged view, full-text search across subject, body and people |
| AI | Summarize, draft reply, draft new mail, rewrite, triage. Works without a key using a basic built-in fallback |
| Delivery | Own inbound SMTP server (MX) for every verified domain; inbound webhooks for Postmark or any relay; outbound through Amazon SES or Postmark SMTP relay; local delivery between Arzio users |
| Tenants | Public tenant with open signup; private organizations with domains, DNS verification (TXT), user add / disable / reset password / admin role, user limits |
| Security | scrypt password hashing, HttpOnly session cookies, rate limits on signup, login and AI, per-user daily send limit, mailbox quota, HTML mail rendered in a sandboxed iframe with no scripts, CSP headers |
| Clients | Responsive web app (desktop and phone browsers); REST API under `/api` for future mobile apps |

## Run it locally

Requires Node.js 22.5 or newer.

```bash
npm install
cp .env.example .env          # optional; defaults work for local testing
ARZIO_DOMAIN=arzio.com ARZIO_ADMIN_EMAILS=admin@arzio.com npm start
# open http://localhost:3000 and create an account
```

In development, outbound mail to outside addresses is written to `data/outbox/*.eml` instead of being sent (`OUTBOUND_TRANSPORT=log`). Mail between Arzio users is delivered for real. The inbound SMTP server listens on port 2525; test it with:

```bash
swaks --server localhost:2525 --to alice@arzio.com --from friend@example.com --body "Hello"
```

To turn on Claude, set `ANTHROPIC_API_KEY` (and optionally `AI_MODEL`, default `claude-opus-5-5`).

Create a service admin (can create private organizations):

```bash
npm run create-admin -- admin 'a-strong-password' "Arzio Admin"
```

Run the tests: `npm test`.

## Production setup (SES/Postmark out, own inbound)

1. **Server:** a VM with a public IP, ports 25 (SMTP) and 443 (HTTPS via nginx or a load balancer) open. Run with Docker (`docker build -t arzio-mail .`) or `npm start` under systemd. Keep `/data` on a persistent disk and back it up.
2. **DNS for arzio.com:**
   - `A mail.arzio.com` and `A mx.arzio.com` pointing at the server.
   - `MX arzio.com 10 mx.arzio.com`.
   - SPF: `TXT arzio.com "v=spf1 include:amazonses.com ~all"` (Postmark: `include:spf.mtasv.net`).
   - DKIM: the CNAME/TXT records SES or Postmark gives you when you verify the domain.
   - DMARC: `TXT _dmarc.arzio.com "v=DMARC1; p=quarantine; rua=mailto:dmarc@arzio.com"`.
3. **Outbound:** verify `arzio.com` in SES (and request production access to leave the sandbox) or in Postmark, create SMTP credentials, and set `OUTBOUND_TRANSPORT=relay`, `SMTP_RELAY_HOST/PORT/USER/PASS`.
4. **Inbound:** set `INBOUND_SMTP_PORT=25` and point `INBOUND_TLS_KEY/CERT` at a certificate for `mx.arzio.com` (Let's Encrypt) so senders can use STARTTLS.
5. **HTTPS:** put nginx or a load balancer in front of port 3000 and set `SECURE_COOKIES=true`, `TRUST_PROXY=true`.
6. **Private organizations:** the service admin creates the organization in **Service admin**. The organization admin signs in, opens **Organization admin**, adds the TXT, MX, SPF and DMARC records shown there, clicks **Check DNS**, then adds users. Each custom domain also needs to be verified in SES/Postmark for sending.

## Code layout

```
src/
  server.js            HTTP server, security headers, starts inbound SMTP
  config.js            all settings (environment variables)
  db.js                SQLite schema: organizations, domains, users, folders, messages, attachments, FTS index
  auth.js              accounts, passwords, sessions, tenant-aware user creation
  routes/api.js        REST API (mail, folders, drafts, AI, org admin, service admin, inbound webhooks)
  mail/store.js        mailbox storage, threading, search
  mail/delivery.js     inbound delivery of raw MIME, outbound sending, local delivery
  mail/smtp-inbound.js MX server
  ai/index.js          AI service facade
  ai/anthropic.js      Claude provider (structured outputs, refusal fallback)
  ai/heuristic.js      built-in fallback when no AI key is set
public/                web client (index.html, app.js, styles.css)
scripts/create-admin.js
test/api.test.js
```

## Known limits of Phase 1 (planned next)

- SQLite on one server: fine for early users; move to PostgreSQL and object storage before large scale (Phase 5).
- No spam or virus filtering yet on inbound mail (Phase 2: Rspamd and ClamAV, SPF/DKIM/DMARC checks).
- No outbound retry queue or bounce handling yet (Phase 2).
- No IMAP or SMTP submission yet, so desktop apps such as Outlook or Thunderbird cannot connect (Phase 3).
- No calendar, contacts or tasks yet (Phases 2 and 3). No MFA yet (Phase 2).
- The Claude integration was tested up to the API call; run one summary with a real `ANTHROPIC_API_KEY` to confirm end to end.
