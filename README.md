# Arzio Mail

Arzio Mail is a standalone email service, public and private like Outlook:

- **Public:** anyone can sign up for a free `name@arzio.com` address (Outlook.com / Gmail style).
- **Private:** organizations get their own tenant with custom domains (`name@company.com`), an organization admin console and user management (Microsoft 365 business style).

It has built-in AI (Claude by default): thread summaries with action items, reply and new-mail drafting, rewrite (improve, shorten, formal, friendly), and automatic inbox triage that drives the Focused / Other inbox.

## What's included

| Area | Features |
| --- | --- |
| Mail | Inbox, Drafts, Sent Items, Archive, Junk, Deleted Items, custom folders, Favorites; reply, reply all, forward; attachments; conversation view (on or off); read/unread, flag, pin, categories; drag to folder; signatures; templates; print; reactions (👍 ❤️ 🎉 😆 😮 😢) shared with everyone on the message |
| Ribbon | Outlook-style ribbon with File, Home, Send / Receive, Folder, View and Help tabs, Classic or Simplified layout, groups that fold into drop-downs on narrow screens. Home: New Email / New Items; Ignore, Clean Up, Junk, Delete, Archive; Reply, Reply All, Forward, reply with a Meeting, forward as an attachment; Quick Steps (Move to, To Manager, Team Email, Done, Reply & Delete, or your own); Move, Rules, Save as File; Unread/Read, Categorize, Follow Up (today, tomorrow, this week, next week, custom, mark complete); New Group and Browse Groups (contact groups and organization groups); Search People, Address Book, Filter Email; Read Aloud; Translate; Arzio AI; Insights. Ctrl+click or Shift+click selects several messages |
| Writing | Rich-text editor like Outlook: fonts, sizes, colours, highlight, lists, indent, alignment, quotes, links, tables, emoji, pasted or dropped pictures sent inline; @mentions that add the person to To and show "@" in their inbox; importance (high / low); read receipts; check for a missing attachment or subject |
| Reading | Translator (via Claude), Immersive Reader (text size, spacing, fonts, themes, line focus, read aloud), "Mentions me" view, read-receipt prompt |
| Appearance | Light, dark or device theme; seven accent colours; reading pane on the right, at the bottom or hidden; roomy, comfortable or compact density; text size; sender pictures and preview text on or off; Outlook or Gmail keyboard shortcuts (press ? for the list) |
| Inbox | Focused / Other, AI priority and "needs reply" tags, full-text search, snooze, sweep, inbox rules, automatic replies (out of office), safe and blocked senders |
| Sending | Undo send, scheduled send, send as alias / shared mailbox / on behalf of, contacts autocomplete, retrying delivery queue with bounce notices |
| Calendar | Day, week and month views; share your calendar (free/busy, all details, or edit) and show people's calendars side by side; meeting invitations to anyone (iCalendar, works with Outlook and Gmail); accept / tentative / decline; updates and cancellations; recurring events; reminders; scheduling assistant (free/busy for colleagues); .ics import; private subscription link for Google / Apple / Outlook calendars |
| To Do | Task lists, due dates, reminders, important, flagged email as tasks, "Add to To Do" from any message |
| People | Contacts with vCard export; suggested recipients from your mail and your organization directory |
| AI | Summarize, draft and rewrite, triage, writing coach, "Ask Arzio" questions over your mailbox, meeting prep briefs. Claude by default, pluggable; a basic built-in fallback works without a key |
| AI agents | MCP server at `/mcp` so assistants such as Claude can search and read mail, send, create events and tasks with a personal API token (read-only or read-and-act) |
| Mail apps | IMAP server and SMTP submission, so Outlook desktop, Apple Mail, Thunderbird and phone mail apps work; app passwords for accounts with two-step verification |
| Phone sync | Exchange ActiveSync: add an "Exchange" account on iPhone, Android, Outlook for iOS/Android or Samsung Email and get mail, calendar, contacts and tasks with instant push; remote wipe and block from Settings. CalDAV and CardDAV for Mac, Thunderbird and DAVx⁵ |
| Phone app | Native iPhone and Android app (Expo, in [mobile/](mobile/README.md)): mail with folders, Focused / Other and search, safe HTML viewing, reply and forward with attachments, AI summary and drafts, calendar agenda with invitation replies, To Do, out of office, push notifications for new mail and reminders |
| Install | Installable web app (PWA) on Windows, Mac, Android and iPhone, with reminders as notifications |
| Tenants | Public tenant with open signup; private organizations with custom domains and DNS verification |
| Admin center | Users, shared mailboxes (support@, info@), groups / distribution lists, domains, mail flow rules with data loss prevention (card, Aadhaar, PAN, IBAN, SSN), message trace, audit log, usage reports |
| Compliance | Retention policies, litigation hold (deleted mail kept hidden), eDiscovery search across all mailboxes with .mbox export |
| Connected accounts | Use a mailbox hosted elsewhere (Hostinger, Zoho, Gmail, Microsoft 365, any IMAP/SMTP) inside Arzio, like Outlook's "Add account": new mail is copied into its own folder every few minutes, replies default to that address and go out through the provider's own SMTP (a copy lands in its Sent folder too), so the domain's DNS doesn't change. Passwords are stored encrypted (AES-256-GCM). Off in the public demo |
| Migration | Import from Gmail, Outlook / Microsoft 365, Yahoo, Zoho or any IMAP account in the background; .mbox (Google Takeout) and .eml upload |
| Plans and billing | Free and Premium plans for personal accounts, per-user Business Basic and Standard plans for organizations; storage, sending, AI and feature limits per plan; Razorpay (UPI, cards) and Stripe checkout, GST invoices, cancel and seat changes, manual plans for bank transfers; revenue view for the operator ([docs/BILLING.md](docs/BILLING.md)) |
| Scale | SQLite for one server, or PostgreSQL (`ARZIO_DB_URL`) for many; mail files on disk or in S3-compatible storage (S3, R2, B2, MinIO); one-step migration scripts; background jobs fail over between servers |
| Operations | `/health`, `/ready` and Prometheus `/metrics`; graceful shutdown; live backups with rotation and a checked restore; Docker, nginx and systemd kit |
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

Run the tests: `npm test` (39 tests).

### Connecting a mail app

In development IMAP listens on port 1143 and SMTP submission on 1587 without TLS. In production set `IMAP_PORT=993 IMAP_TLS=true`, `SUBMISSION_PORT=465 SUBMISSION_TLS=true` and `MAIL_TLS_KEY/MAIL_TLS_CERT` for `mail.arzio.com`. Users see the exact settings in **Settings > Phones, mail apps & AI agents**, where they can also create app passwords.

### Connecting an AI assistant (MCP)

Create a token in **Settings > Phones, mail apps & AI agents**, then add `https://mail.arzio.com/mcp` as a remote MCP server with the header `Authorization: Bearer <token>`. Tools: `list_folders`, `search_mail`, `read_message`, `list_events`, `list_tasks`, and with a read-and-act token `send_mail`, `create_event`, `create_task`, `complete_task`. The same token works with the REST API: see [docs/API.md](docs/API.md).

### Phones (Exchange ActiveSync)

On the phone add an **Exchange** account with the Arzio address and password (an app password with two-step verification on). The server is `mail.arzio.com`; most apps find it on their own through `/autodiscover/autodiscover.xml` if `autodiscover.arzio.com` points at the server. Mail, calendar, contacts and tasks sync both ways, new mail is pushed, and sending, replying, forwarding, moving, search, out-of-office and meeting replies all work from the phone. Users see their phones in **Settings > Phones, mail apps & AI agents** and can block, remove or remotely wipe one. Set `ARZIO_EAS_REQUIRE_PASSCODE=6` to make phones use a screen lock of at least 6 digits.

### Calendar and contacts on a Mac or with DAVx⁵

Add a CalDAV account and a CardDAV account with server `https://mail.arzio.com/dav/` (apps also find it from just `mail.arzio.com`), your address and your password or an app password.

## Production setup (SES/Postmark out, own inbound)

The full guide is [docs/DEPLOY.md](docs/DEPLOY.md): DNS records, SES or Postmark, certificates, and install with Docker Compose (`deploy/docker-compose.yml` with nginx) or systemd (`deploy/systemd/`). Running it day to day, monitoring, backups, restore and the plan for growing past one server are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

Short version:

```bash
cp .env.example deploy/.env      # domain, relay credentials, AI key, TLS paths
docker compose -f deploy/docker-compose.yml up -d --build
curl https://mail.arzio.com/ready
```

Private organizations: the service admin creates the organization in **Service admin**. The organization admin opens the **Admin center**, adds the TXT, MX, SPF and DMARC records shown under **Domains**, clicks **Check DNS**, then adds users. Each custom domain also needs to be verified in SES/Postmark for sending.

## Code layout

```
src/
  server.js              HTTP server, security headers, starts SMTP/IMAP, graceful shutdown
  config.js              all settings (environment variables)
  db.js                  schema and upgrades (SQLite or PostgreSQL)
  sql/                   PostgreSQL translation, sync bridge, S3 client
  blobs.js               mail file storage (disk or S3)
  auth.js                accounts, passwords, sessions, app passwords, API tokens
  health.js              /health, /ready, /metrics
  billing.js             plans, limits, Stripe and Razorpay, invoices
  dav.js                 CalDAV and CardDAV
  eas/                   Exchange ActiveSync (WBXML, sync, push, provisioning)
  mcp.js                 MCP server for AI agents
  push.js                push notifications to the phone app
  audit.js, mfa.js, maintenance.js
  routes/api.js          mail, folders, drafts, AI, org and service admin, inbound webhooks
  routes/features.js     rules, templates, contacts, senders, aliases, delegates, preferences
  routes/calendar.js     calendar, To Do, notifications, app passwords, tokens
  routes/admin.js        admin center: shared mailboxes, groups, mail flow, trace, compliance, import
  mail/store.js          mailbox storage, threading, search, litigation hold
  mail/delivery.js       inbound delivery, outbound sending, queue, local delivery
  mail/smtp-inbound.js   MX server
  mail/smtp-submission.js SMTP for mail apps
  mail/imap.js           IMAP server
  mail/import.js         import from other accounts and files
  mail/transport-rules.js mail flow rules and data loss prevention
  calendar/              events, invitations (iMIP), recurrence, iCalendar
  ai/                    AI facade, Claude provider, built-in fallback
public/                  web app (PWA)
mobile/                  iPhone and Android app (Expo / React Native)
scripts/                 create-admin, backup, restore
deploy/                  docker-compose, nginx, systemd, certificate hook
docs/                    DEPLOY, OPERATIONS, API, BILLING
test/                    49 end-to-end tests
```

## Known limits

- Virus scanning of attachments is not built in; add ClamAV at the MX for production.
- The phone app was tested as a web build in a browser at phone size and type-checked; build it with EAS and try it on real phones before publishing to the stores. Push needs an Expo project (`eas init`).
- Exchange Web Services (EWS) and MAPI are not supported, so Outlook for Windows and Mac connects over IMAP (its calendar then comes from the subscription link or CalDAV). Phones use Exchange ActiveSync. ActiveSync was tested with a scripted phone client that follows the protocol documents, not yet with each phone model; try your phones before rollout.
- S/MIME and Microsoft Purview-style message encryption are not built in. Mail is protected in transit with TLS (set the TLS certificates) and access is controlled by sign-in and two-step verification.
- Microsoft 365 work accounts can only be imported if their admin allows IMAP with basic sign-in; otherwise export to .pst/.mbox first.
- Online meetings: events take a meeting link (Teams, Zoom, Meet, Jitsi), but Arzio has no video service of its own.
- The Claude integration was tested up to the API call; run one summary with a real `ANTHROPIC_API_KEY` to confirm end to end.
