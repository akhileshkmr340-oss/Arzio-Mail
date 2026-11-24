# Arzio Mail

Arzio Mail is a standalone email service, public and private like Outlook:

- **Public:** anyone can sign up for a free `name@arzio.com` address (Outlook.com / Gmail style).
- **Private:** organizations get their own tenant with custom domains (`name@company.com`), an organization admin console and user management (Microsoft 365 business style).

It has built-in AI (Claude by default): thread summaries with action items, reply and new-mail drafting, rewrite (improve, shorten, formal, friendly), and automatic inbox triage that drives the Focused / Other inbox.

## What's included

| Area | Features |
| --- | --- |
| Mail | Inbox, Drafts, Sent Items, Archive, Junk, Deleted Items, custom folders; compose, reply, reply all, forward; attachments; threading; read/unread, flag, pin, categories; drag to folder; signatures; templates |
| Inbox | Focused / Other, AI priority and "needs reply" tags, full-text search, snooze, sweep, inbox rules, automatic replies (out of office), safe and blocked senders |
| Sending | Undo send, scheduled send, send as alias / shared mailbox / on behalf of, contacts autocomplete, retrying delivery queue with bounce notices |
| Calendar | Day, week and month views; meeting invitations to anyone (iCalendar, works with Outlook and Gmail); accept / tentative / decline; updates and cancellations; recurring events; reminders; scheduling assistant (free/busy for colleagues); .ics import; private subscription link for Google / Apple / Outlook calendars |
| To Do | Task lists, due dates, reminders, important, flagged email as tasks, "Add to To Do" from any message |
| People | Contacts with vCard export; suggested recipients from your mail and your organization directory |
| AI | Summarize, draft and rewrite, triage, writing coach, "Ask Arzio" questions over your mailbox, meeting prep briefs. Claude by default, pluggable; a basic built-in fallback works without a key |
| AI agents | MCP server at `/mcp` so assistants such as Claude can search and read mail, send, create events and tasks with a personal API token (read-only or read-and-act) |
| Mail apps | IMAP server and SMTP submission, so Outlook desktop, Apple Mail, Thunderbird and phone mail apps work; app passwords for accounts with two-step verification |
| Install | Installable web app (PWA) on Windows, Mac, Android and iPhone, with reminders as notifications |
| Tenants | Public tenant with open signup; private organizations with custom domains, DNS verification, user management, groups, mail flow rules, retention and litigation hold |
| Security | scrypt passwords, two-step verification (authenticator apps), HttpOnly sessions, rate limits, SPF/DKIM/DMARC checks and spam scoring on inbound mail, sandboxed HTML mail, CSP, audit log |

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

### Connecting a mail app

In development IMAP listens on port 1143 and SMTP submission on 1587 without TLS. In production set `IMAP_PORT=993 IMAP_TLS=true`, `SUBMISSION_PORT=465 SUBMISSION_TLS=true` and `MAIL_TLS_KEY/MAIL_TLS_CERT` for `mail.arzio.com`. Users see the exact settings in **Settings > Mail apps & AI agents**, where they can also create app passwords.

### Connecting an AI assistant (MCP)

Create a token in **Settings > Mail apps & AI agents**, then add `https://mail.arzio.com/mcp` as a remote MCP server with the header `Authorization: Bearer <token>`. Tools: `list_folders`, `search_mail`, `read_message`, `list_events`, `list_tasks`, and with a read-and-act token `send_mail`, `create_event`, `create_task`, `complete_task`.

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

## Known limits

- SQLite on one server: fine for early users; move to PostgreSQL and object storage before large scale.
- Virus scanning of attachments is not built in; add ClamAV at the MX for production.
- Native iOS and Android apps are not included. Phones use the installable web app, or their built-in mail app over IMAP.
- Exchange ActiveSync and EWS are not supported; Outlook desktop connects over IMAP.
- Online meetings: events take a meeting link (Teams, Zoom, Meet, Jitsi), but Arzio has no video service of its own.
- The Claude integration was tested up to the API call; run one summary with a real `ANTHROPIC_API_KEY` to confirm end to end.
