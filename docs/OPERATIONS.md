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
that takes longer than 30 minutes.

Steps, in order of payoff:

1. **Bigger disk and more RAM.** The cheapest step. SQLite with WAL is fast on
   NVMe.
2. **Attachments and raw messages to object storage** (S3, R2, B2). They are
   most of the disk. `store.js` reads and writes them through two folders
   (`data/attachments`, `data/raw`), which is the only place to change.
3. **PostgreSQL** for the database, so several web servers can share it:
   - The schema in `src/db.js` is plain SQL. Swap `INTEGER PRIMARY KEY` for
     `BIGSERIAL`, `datetime('now')` for `now()`, and move the IMAP UID
     triggers to PL/pgSQL.
   - Full-text search moves from FTS5 to a `tsvector` column with a GIN index.
   - The code uses synchronous `node:sqlite` calls. Wrap them in a small data
     layer with async methods first, then switch the driver.
   - Migrate with a one-off script that reads every table from SQLite and
     inserts in id order, then resets the sequences.
4. **Several web servers** behind a load balancer once the database is shared.
   Sessions are already in the database. The background workers (queue,
   reminders, maintenance) need a lock so only one server runs each job
   (PostgreSQL advisory locks).
5. **Separate MX servers** that only receive and hand mail to the shared
   database, so a spam flood cannot slow the web app.
