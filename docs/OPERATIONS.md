# Running Arzio Mail

## Health checks and monitoring

| Endpoint | Use | Answer |
| --- | --- | --- |
| `GET /health` | liveness (is the process up) | always `200` while running |
| `GET /ready` | readiness (load balancer, Docker health check) | `200` when the database answers, the data folder is writable and the disk has more than `ARZIO_MIN_FREE_MB` free; `503` otherwise or while shutting down |
| `GET /metrics` | Prometheus | open to localhost only, or to `Authorization: Bearer $METRICS_TOKEN` when that is set |

`/ready` also reports the outbound queue: how many messages wait and how old
the oldest is. A queue older than `ARZIO_MAX_QUEUE_AGE_MIN` is flagged with
`warning: true` but does not take the web app out of service.

Metrics: `arzio_up`, `arzio_uptime_seconds`, `arzio_users`, `arzio_messages`,
`arzio_outbound_queue{status}`, `arzio_received_last_hour`,
`arzio_sent_last_hour`, `arzio_disk_free_bytes`, `arzio_memory_rss_bytes`.

Alerts worth setting:

- `/ready` failing for 2 minutes.
- `arzio_outbound_queue{status="pending"}` above 100 for 15 minutes (relay
  down or credentials expired).
- `arzio_outbound_queue{status="failed"}` rising fast (a sender being
  blocked, or a spam outbreak from one account).
- `arzio_received_last_hour` at 0 during business hours (MX or port 25 down).
- Disk free under 15%.
- Certificate expiry under 14 days (if the renewal hook failed).

Logs go to stdout (`docker compose logs arzio` or `journalctl -u arzio-mail`).

## Backups

`scripts/backup.js` runs while the server is live. It takes a consistent copy
of the database with SQLite `VACUUM INTO`, checks it, and packs it with the
attachment files and original messages into
`arzio-backup-YYYYMMDD-HHMMSS.tar.gz`. It keeps the newest 14 (`--keep`).

```bash
npm run backup -- --out /opt/arzio/backups --keep 14
```

The systemd timer (`deploy/systemd/arzio-backup.timer`) or the cron line in
DEPLOY.md runs it nightly. **Copy the backups off the server** as well, for
example with `rclone copy /opt/arzio/backups remote:arzio-backups` to S3,
Backblaze B2 or Google Drive, ideally with object lock or versioning. A backup
on the same disk does not survive the disk.

Backups contain everyone's mail. Encrypt the off-site copy (rclone `crypt`
remote, or a bucket with server-side encryption) and limit who can read it.

### Restore

```bash
sudo systemctl stop arzio-mail                     # or: docker compose stop arzio
ARZIO_DATA_DIR=/opt/arzio/data node scripts/restore.js /opt/arzio/backups/arzio-backup-20261124-023000.tar.gz --force
sudo systemctl start arzio-mail
```

`--force` moves the current data folder aside to
`data.before-restore-<time>` instead of deleting it. Without `--force` restore
only writes into an empty folder. The script checks the restored database
before it finishes.

With Docker, run the restore in a one-off container that mounts the volume:

```bash
docker compose -f deploy/docker-compose.yml stop arzio
docker compose -f deploy/docker-compose.yml run --rm --no-deps arzio \
  node --no-warnings scripts/restore.js /backups/arzio-backup-20261124-023000.tar.gz --force
docker compose -f deploy/docker-compose.yml start arzio
```

Test a restore every quarter on a spare machine. A backup you have never
restored is not a backup yet.

## Shutdown and restarts

On `SIGTERM` (`docker stop`, `systemctl stop`) Arzio marks itself not ready,
stops accepting new connections, says goodbye to IMAP clients, lets open
requests finish, and closes the database cleanly. It exits by itself after 15
seconds at most. Mail apps reconnect on their own. Inbound senders retry, so a
restart loses no mail.

## Day-to-day jobs

These run inside the server, with nothing to schedule:

- Outbound queue retries with backoff, then a bounce notice to the sender.
- Scheduled send and undo send.
- Calendar and task reminders.
- Hourly maintenance: empties Deleted Items after each user's setting, applies
  organization retention, clears expired sessions and old queue rows. Nothing
  is deleted while an organization is on litigation hold.

## Phones (Exchange ActiveSync)

Phones keep one request open to `/Microsoft-Server-ActiveSync` for push and
the server checks their folders every `ARZIO_EAS_POLL_MS` (5 seconds). Any
proxy in front must allow requests that last longer than
`ARZIO_EAS_MAX_HEARTBEAT` (28 minutes); the nginx kit sets 30 minutes for that
path. With several servers this works unchanged, because the phone's sync
state is in the database.

- Users see and manage their phones in **Settings > Phones, mail apps & AI
  agents**: block, allow, remove, or wipe a lost phone. Every new phone, block
  and wipe is written to the audit log (`security.device.*`).
- A wipe resets most phones to factory settings. The phone confirms it and the
  device shows as **Wiped**.
- Changing a user's password, or removing their app password, stops their
  phones at the next request.
- To see what a phone sends, set `ARZIO_EAS_DEBUG=true` for a short time. The
  log then contains mail content; turn it off afterwards.

## Security checklist

- Two-step verification on for every admin account.
- `.env` readable by the service user only (`chmod 600`).
- Only ports 22, 25, 80, 443, 465 and 993 open. Port 3000 bound to localhost.
- SSH with keys only. Unattended security upgrades on.
- Review **Admin center > Audit log** for `admin.*` and `security.*` events.
- Add attachment virus scanning (ClamAV) before opening signups to the public.

## Growing past one server

One server with SQLite handles a few thousand active mailboxes. The signs it
is time to grow: p95 web response above 500 ms, disk above 70%, or a backup
that takes longer than 30 minutes. Arzio supports each step below with a
setting; no code changes.

### 1. Mail files to S3-compatible storage

Attachments, original messages and queued outgoing mail are most of the disk.
Put them in Amazon S3, Cloudflare R2, Backblaze B2, Wasabi or MinIO:

```
ARZIO_S3_BUCKET=arzio-mail
ARZIO_S3_REGION=ap-south-1
ARZIO_S3_ENDPOINT=https://s3.ap-south-1.amazonaws.com   # R2: https://<account>.r2.cloudflarestorage.com
ARZIO_S3_ACCESS_KEY=...
ARZIO_S3_SECRET_KEY=...
ARZIO_S3_PATH_STYLE=false                              # true for MinIO
ARZIO_S3_PREFIX=mail
```

New files go to the bucket at once; existing files keep working from disk.
Move the old ones with `node scripts/migrate-files-to-s3.js` (run again with
`--delete` to free the disk). Keep the bucket private, turn on versioning and
server-side encryption, and give the access key rights to this bucket only.
With S3 on, `scripts/backup.js` backs up only the database; the bucket's
versioning is the backup for files.

### 2. PostgreSQL

```
ARZIO_DB_URL=postgres://arzio:password@db.internal:5432/arzio
ARZIO_DB_SSL=true            # for a managed database; "no-verify" for self-signed
```

Create the database with byte-order collation so dates and addresses compare
exactly:

```sql
CREATE DATABASE arzio TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
```

PostgreSQL 14 or newer. Arzio creates its tables on first start. To move an
existing server: stop it, then

```bash
ARZIO_DATA_DIR=/opt/arzio/data ARZIO_DB_URL=postgres://... node scripts/migrate-to-postgres.js
```

It copies every table in one transaction (all or nothing), keeps IMAP message
numbers so mail apps do not download everything again, and rebuilds the
search index. Keep the old `arzio.db` until you are happy.

Backups with PostgreSQL: `scripts/backup.js` calls `pg_dump`, so install the
PostgreSQL client tools of the same major version. Managed databases (RDS,
Cloud SQL, Neon, Supabase) also take their own snapshots; keep both.

The whole test suite runs against PostgreSQL too:
`ARZIO_DB_URL=postgres://... ARZIO_DB_SCHEMA=auto npm test`.

### 3. Several servers

With PostgreSQL and S3, run as many Arzio servers as you need behind a load
balancer, all with the same `.env`:

- Sessions live in the database, so any server can answer any request.
- Only one server at a time runs the background jobs (outbound queue,
  reminders, maintenance). It holds a PostgreSQL advisory lock; if it stops,
  another server takes over within seconds.
- Point the MX records at two or more servers for inbound mail; sending
  servers retry the other one if one is down.
- IMAP and SMTP for mail apps work on every server; a TCP load balancer
  (nginx `stream`, HAProxy, a cloud network load balancer) spreads them.

Each server keeps one database connection and runs queries in order, so plan
on one server per 2 CPU cores and add servers rather than cores.
