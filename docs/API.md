# Arzio Mail API

Everything the web app does goes through this JSON API, so anything you can do
in the app you can automate.

- Base URL: `https://mail.arzio.com/api`
- Requests with a body are JSON (`Content-Type: application/json`).
- Errors come back as `{ "error": "message" }` with a 4xx or 5xx status.

## Signing in

**Personal API token (scripts, integrations).** Create one in **Settings >
Mail apps & AI agents** or with `POST /api/me/tokens` `{ "name": "CRM", "scopes": ["read", "send"] }`.
The token is shown once. Send it as `Authorization: Bearer arz_...`.

- `read` tokens can only make GET requests.
- `read,send` tokens can also send mail and change mail, calendar, contacts
  and tasks.
- No token can change your account, security settings, organization or
  service admin settings, or create more tokens.

**Session cookie (the web app).** `POST /api/auth/login` `{ "email", "password", "code"? }`
sets an HttpOnly cookie.

**App session (the phone app).** The same call with `"client": "app"` returns
`{ "session", "expires" }` instead of a cookie. Send it as `X-Arzio-Session: <session>`.
`POST /api/auth/logout` with that header ends it.

**Shared mailboxes.** Add `X-Arzio-Mailbox: <id>` (from `GET /api/me/mailboxes`)
to act in a shared mailbox you are a member of.

```bash
curl -H "Authorization: Bearer $ARZIO_TOKEN" "https://mail.arzio.com/api/messages?q=invoice&limit=10"
curl -H "Authorization: Bearer $ARZIO_TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"priya@globex.com","subject":"Hello","text":"Sent from the API"}' \
  https://mail.arzio.com/api/send
```

## Mail

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/folders` | folders with unread and total counts |
| POST, PATCH, DELETE | `/folders`, `/folders/:id` | create, rename, delete a folder |
| GET | `/messages?folder=&q=&limit=&before=&focused=` | list or search messages |
| GET | `/messages/:id` | one message with body, attachments, invitation |
| GET | `/threads/:threadId` | a whole conversation |
| PATCH | `/messages/:id` | `{ is_read, is_flagged, is_pinned, is_focused, folder_id, categories, snooze_until }` |
| DELETE | `/messages/:id` | move to Deleted Items, or delete for good from there |
| POST | `/messages/bulk` | the same changes for many ids |
| POST | `/messages/sweep` | move or delete everything from a sender |
| POST | `/messages/:id/report` | report junk or not junk |
| GET | `/attachments/:id` | download an attachment |
| POST | `/send` | `{ to, cc, bcc, subject, text, html, from, attachments[], inReplyTo, sendAt, importance: "high" \| "low", readReceipt, noSignature }`. Pictures in `html` as `data:` URLs go out as inline attachments; `<a data-mention="addr">` marks an @mention |
| GET | `/messages?mentions=1` | messages that @mention you |
| POST | `/messages/:id/receipt` | `{ send: true \| false }`: answer a read-receipt request |
| POST | `/messages/:id/reactions`, `/reactions/lookup` | `{ emoji }` to react (again to remove); `{ ids[] }` to read reactions |
| POST | `/ai/translate` | `{ messageId, to: "Hindi" }`: translate a message (needs Claude) |
| POST | `/drafts` | save a draft |
| GET, POST | `/outbox`, `/outbox/:id/cancel` | scheduled and queued mail, cancel one |

## Settings, rules and people

| Method | Path | What it does |
| --- | --- | --- |
| GET, PATCH | `/me`, `/me/preferences` | profile, signature, automatic replies, undo send, focused inbox |
| PATCH | `/me/ui` | `{ theme, accent, density, readingPane, textSize, shortcuts, conversations, senderImages, previewText, favorites[] }` (also in `/me` as `ui_json`) |
| GET, POST, PUT, DELETE | `/rules`, `/rules/:id`, `/rules/run` | inbox rules |
| GET, POST, DELETE | `/templates`, `/templates/:id` | message templates |
| GET, POST, DELETE | `/senders`, `/senders/:id` | safe and blocked senders |
| GET, POST, PUT, DELETE | `/contacts`, `/contacts/:id` | contacts |
| GET | `/contacts/suggest?q=` | recipient suggestions |
| GET | `/contacts.vcf` | all contacts as vCard |
| GET, POST, DELETE | `/me/aliases`, `/me/delegates` | aliases, mailbox delegates |
| GET | `/me/identities`, `/me/mailboxes` | addresses you can send from, mailboxes you can open |
| GET, POST, DELETE | `/me/app-passwords` | app passwords for mail apps |
| GET | `/me/devices` | phones connected with Exchange ActiveSync |
| POST, DELETE | `/me/push-tokens` | `{ token, platform, deviceName }`: the phone app's Expo push token |
| POST | `/me/devices/:id` | `{ "action": "block" \| "allow" \| "wipe" \| "remove" }` |
| GET, POST, DELETE | `/me/tokens` | API tokens |
| GET, POST | `/me/import`, `/me/import/imap`, `/me/import/file` | import from another account or an .mbox / .eml file |

## Calendar and To Do

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/calendar/events?from=&to=` | events, recurring ones expanded |
| GET, POST, DELETE | `/calendar/shares`, `/calendar/shares/:id` | `{ email, role: "freebusy" \| "view" \| "edit" }`: share your calendar; lists what you gave and received |
| GET, POST, PUT, DELETE | `/calendar/shared/:ownerId/events[/:id]` | read (or, with edit rights, change) a calendar shared with you |
| GET, POST, PUT, DELETE | `/calendar/events`, `/calendar/events/:id` | create, change, cancel; attendees get invitations |
| POST | `/calendar/events/:id/respond` | `{ status: accepted, tentative, declined }` |
| POST | `/calendar/freebusy` | `{ emails[], from, to }` busy times for colleagues |
| POST | `/calendar/import` | `{ ics }` import an .ics file |
| GET, POST | `/calendar/feed` | private subscription link, reset it |
| POST | `/calendar/events/:id/brief` | AI meeting prep |
| GET, POST, PATCH, DELETE | `/tasks`, `/tasks/:id` | tasks and lists |
| GET, POST | `/notifications`, `/notifications/read` | reminders and alerts |

## AI

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/ai/summarize` | `{ messageId }` or `{ thread }`: summary and action items |
| POST | `/ai/draft` | `{ messageId?, instructions, tone }` draft a reply or new mail |
| POST | `/ai/rewrite` | `{ text, style }` improve, shorten, formal, friendly |
| POST | `/ai/triage` | priority and needs-reply for messages |
| POST | `/ai/coach` | writing feedback |
| POST | `/ai/ask` | `{ question }` answer from your mailbox, with sources |

## Organization admin (organization admins only)

| Method | Path | What it does |
| --- | --- | --- |
| GET, POST, PATCH | `/org/users`, `/org/users/:id` | users |
| GET, POST | `/org/domains`, `/org/domains/:id/verify` | custom domains and DNS check |
| GET, POST, PUT | `/org/shared-mailboxes`, `/org/shared-mailboxes/:id/members` | shared mailboxes |
| GET, POST, PUT, DELETE | `/org/groups`, `/org/groups/:id` | groups and distribution lists |
| GET | `/org/sensitive-types` | data loss prevention types |
| GET, POST, PUT, DELETE | `/org/transport-rules`, `/org/transport-rules/:id` | mail flow rules: block, disclaimer, copy to |
| GET | `/org/message-trace?q=&days=` | message trace |
| GET, PATCH | `/org/compliance` | retention and litigation hold |
| POST | `/org/ediscovery/search`, `/org/ediscovery/export` | search all mailboxes, export .mbox |
| GET | `/org/audit?action=` | audit log |
| GET | `/org/reports` | usage reports |

## Other ways in

| Protocol | Address | Use |
| --- | --- | --- |
| MCP | `https://mail.arzio.com/mcp` with `Authorization: Bearer <token>` | AI assistants such as Claude: `list_folders`, `search_mail`, `read_message`, `list_events`, `list_tasks`, and with a send token `send_mail`, `create_event`, `create_task`, `complete_task` |
| Exchange ActiveSync | `https://mail.arzio.com/Microsoft-Server-ActiveSync` (found from `/autodiscover/autodiscover.xml`), protocol 12.0 to 14.1 | phones: mail, calendar, contacts, tasks, push, remote wipe |
| IMAP | `mail.arzio.com:993` TLS | desktop and phone mail apps |
| SMTP | `mail.arzio.com:465` TLS, sign-in required | sending from mail apps |
| CalDAV / CardDAV | `https://mail.arzio.com/dav/` (found from `/.well-known/caldav`) | calendar and contacts sync on iPhone, Mac, Android (DAVx⁵), Thunderbird |
| iCalendar feed | `/api/calendar/feed/<token>.ics` | read-only calendar subscription |
| Inbound webhook | `POST /api/inbound/raw`, `/api/inbound/postmark` with `INBOUND_WEBHOOK_SECRET` | receive mail through a provider instead of your own MX |
