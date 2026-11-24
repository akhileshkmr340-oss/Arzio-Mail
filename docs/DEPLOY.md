# Deploying Arzio Mail

This guide puts Arzio Mail on one Linux server with its own inbound mail (MX),
outbound mail through Amazon SES or Postmark, HTTPS through nginx, and nightly
backups. Replace `arzio.com` with your domain everywhere.

One server with 2 vCPU, 4 GB RAM and a 100 GB SSD is enough for a few
thousand mailboxes. See [OPERATIONS.md](OPERATIONS.md) for when to grow.

## 1. Before you start

- A VM with a public IPv4 address, Ubuntu 24.04 or Debian 12.
- **Port 25 open both ways.** Many clouds block it by default. AWS, Google
  Cloud and Azure need a request. Hetzner, OVH and DigitalOcean allow it after
  a check. Without inbound port 25 you cannot receive mail from the internet.
- **Reverse DNS (PTR)** for the IP set to `mx.arzio.com` in your provider's
  console. Receiving servers trust you more when it matches.
- An SES or Postmark account for sending.

Firewall: allow 22, 25, 80, 443, 465 and 993. Nothing else.

## 2. DNS records

| Type | Name | Value |
| --- | --- | --- |
| A | `mail.arzio.com` | server IP (web app, Exchange ActiveSync, IMAP, SMTP for mail apps, CalDAV) |
| CNAME | `autodiscover.arzio.com` | `mail.arzio.com` (phones find the Exchange server from the address alone; needs a certificate that includes this name) |
| A | `mx.arzio.com` | server IP (inbound mail) |
| MX | `arzio.com` | `10 mx.arzio.com` |
| TXT | `arzio.com` | `v=spf1 include:amazonses.com ~all` (Postmark: `include:spf.mtasv.net`) |
| CNAME/TXT | as given | DKIM records from SES or Postmark when you verify the domain |
| TXT | `_dmarc.arzio.com` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@arzio.com` |
| SRV | `_caldavs._tcp.arzio.com` | `0 1 443 mail.arzio.com` (optional, helps phones find calendars) |
| SRV | `_carddavs._tcp.arzio.com` | `0 1 443 mail.arzio.com` (optional) |
| SRV | `_imaps._tcp.arzio.com` | `0 1 993 mail.arzio.com` (optional, mail app autoconfig) |
| SRV | `_submissions._tcp.arzio.com` | `0 1 465 mail.arzio.com` (optional) |

Each private organization adds its own records for its custom domain. The
admin center shows them under **Domains**.

## 3. Outbound mail (SES or Postmark)

1. Verify `arzio.com` in SES (or Postmark) and add the DKIM records it gives.
2. SES only: request production access so you can send to any address.
3. Create SMTP credentials and put them in `.env`:
   `OUTBOUND_TRANSPORT=relay`, `SMTP_RELAY_HOST`, `SMTP_RELAY_PORT=587`,
   `SMTP_RELAY_USER`, `SMTP_RELAY_PASS`.
4. Each organization's custom domain must also be verified in SES/Postmark
   before its users can send outside.

## 4. Certificates

```bash
sudo apt install -y certbot
sudo mkdir -p /var/www/certbot
sudo certbot certonly --standalone -d mail.arzio.com -d mx.arzio.com -d autodiscover.arzio.com
sudo cp deploy/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/arzio.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/arzio.sh
sudo ARZIO_CERT_HOST=mail.arzio.com /etc/letsencrypt/renewal-hooks/deploy/arzio.sh
```

The hook copies the certificate to `/opt/arzio/certs` where Arzio (which does
not run as root) can read it, and restarts Arzio after each renewal so IMAP,
SMTP and the MX use the new certificate. After the first run, later renewals use
the webroot at `/var/www/certbot` served by nginx.

## 5a. Install with Docker (recommended)

```bash
sudo apt install -y docker.io docker-compose-v2 git
sudo mkdir -p /opt/arzio/backups && sudo chown 1000 /opt/arzio/backups
sudo git clone https://github.com/<you>/arzio-mail.git /opt/arzio/app
cd /opt/arzio/app
cp .env.example deploy/.env && nano deploy/.env      # fill it in (section 6)
sed -i 's/mail.arzio.com/mail.yourdomain.com/g' deploy/nginx/arzio.conf
docker compose -f deploy/docker-compose.yml up -d --build
curl -s https://mail.arzio.com/ready
```

Ports 25, 465 and 993 go straight to Arzio; 80 and 443 go to nginx, which
forwards to Arzio. The data lives in the `arzio-data` Docker volume.

Nightly backup (host cron):

```bash
echo '30 2 * * * root docker compose -f /opt/arzio/app/deploy/docker-compose.yml exec -T arzio node --no-warnings scripts/backup.js --out /backups --keep 14' | sudo tee /etc/cron.d/arzio-backup
```

Upgrade: `git pull && docker compose -f deploy/docker-compose.yml up -d --build`.
The database schema upgrades itself on start. Take a backup first.

## 5b. Install without Docker (systemd)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs nginx git
sudo useradd --system --home /opt/arzio --shell /usr/sbin/nologin arzio
sudo mkdir -p /opt/arzio/data /opt/arzio/backups && sudo chown -R arzio:arzio /opt/arzio
sudo -u arzio git clone https://github.com/<you>/arzio-mail.git /opt/arzio/app
cd /opt/arzio/app && sudo -u arzio npm ci --omit=dev
sudo -u arzio cp .env.example .env && sudo nano .env       # fill it in (section 6)
sudo cp deploy/systemd/arzio-mail.service deploy/systemd/arzio-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arzio-mail arzio-backup.timer
# nginx: change the upstream in deploy/nginx/arzio.conf to 127.0.0.1:3000
sudo cp deploy/nginx/arzio.conf /etc/nginx/sites-enabled/arzio.conf && sudo nginx -t && sudo systemctl reload nginx
```

Run the certificate hook with `ARZIO_CERT_OWNER=arzio`. For systemd, set the
ports in `.env` to the real ones: `INBOUND_SMTP_PORT=25`, `IMAP_PORT=993`,
`SUBMISSION_PORT=465`. The unit grants permission to bind them.

## 6. Settings that matter in production

| Variable | Value |
| --- | --- |
| `ARZIO_DOMAIN` | your public signup domain, e.g. `arzio.com` |
| `ARZIO_ADMIN_EMAILS` | service admins, e.g. `admin@arzio.com` |
| `MAIL_PUBLIC_HOST` | `mail.arzio.com` (shown in mail app setup) |
| `SECURE_COOKIES`, `TRUST_PROXY` | `true` behind nginx |
| `IMAP_TLS`, `SUBMISSION_TLS` | `true` |
| `INBOUND_TLS_KEY/CERT`, `MAIL_TLS_KEY/CERT` | `/opt/arzio/certs/privkey.pem` and `fullchain.pem` (Docker sets these) |
| `OUTBOUND_TRANSPORT` | `relay`, plus the `SMTP_RELAY_*` values |
| `INBOUND_WEBHOOK_SECRET` | a long random string |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY` | `anthropic` and your key (or `none`) |
| `METRICS_TOKEN` | a random string if anything outside the server reads `/metrics` |

Keep `.env` out of git. It holds your relay password and AI key.

## 7. First sign-in

1. Open `https://mail.arzio.com` and create the account listed in
   `ARZIO_ADMIN_EMAILS` (or run `npm run create-admin -- admin 'password' "Admin"`).
2. Turn on two-step verification for it in **Settings > Security**.
3. Create organizations in **Service admin**. Each organization admin then adds
   their domain, users, shared mailboxes and groups in the **Admin center**.

## 8. Check it works

- `curl https://mail.arzio.com/ready` returns `"ok": true`.
- Send from an outside Gmail account to a new user. It arrives in the inbox.
- Reply. Check the Gmail "Show original" view: SPF, DKIM and DMARC say PASS.
- Add the account to a phone as an **Exchange** account (Settings > Phones,
  mail apps & AI agents shows the server). Mail, calendar and contacts
  appear, and a message sent from another account arrives within seconds.
- Add it to a desktop mail app over IMAP with the settings on the same page.
- Run a backup by hand and restore it onto a test machine once
  ([OPERATIONS.md](OPERATIONS.md#restore)).
