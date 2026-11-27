#!/usr/bin/env bash
# Arzio Mail on a Google Cloud e2-micro (always-free tier) VM, Debian 12.
#
# Paste this one line as the VM's startup script (Create instance > Advanced
# options > Management > Automation > Startup script):
#
#   curl -fsSL https://raw.githubusercontent.com/akhileshkmr340-oss/Arzio-Mail/main/deploy/gcp/startup.sh | bash
#
# It runs on every boot: the first boot installs everything, later boots pull
# the latest code. The app is served over HTTPS at https://<ip-with-dashes>.sslip.io
# (a free name that points at the VM's IP, so no DNS change is needed), with a
# certificate from Let's Encrypt via Caddy.
#
# This is a private server: sign-up closes after the first account (yours).
# Mail for your own domain stays where it is; mailboxes such as a Hostinger
# business email are added under Settings > Connected accounts.
#
# Optional VM metadata keys: arzio-branch (default main), arzio-hostname
# (use your own name, e.g. mail.example.com, once its A record points here).
set -euo pipefail
exec > >(tee -a /var/log/arzio-setup.log) 2>&1
echo "[arzio] setup started $(date -Is)"

md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1" 2>/dev/null || true; }
BRANCH="$(md instance/attributes/arzio-branch)"; BRANCH="${BRANCH:-main}"
IP="$(md instance/network-interfaces/0/access-configs/0/external-ip)"
HOSTNAME_ATTR="$(md instance/attributes/arzio-hostname)"
HOST="${HOSTNAME_ATTR:-${IP//./-}.sslip.io}"
REPO=https://github.com/akhileshkmr340-oss/Arzio-Mail.git
APP=/opt/arzio/app
DATA=/opt/arzio/data

export DEBIAN_FRONTEND=noninteractive

# 1 GB of RAM is tight for npm: add swap once
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap /swapfile; }
  swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node.js 22, git and Caddy
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
command -v git >/dev/null || apt-get install -y git

id arzio >/dev/null 2>&1 || useradd --system --home /opt/arzio --shell /usr/sbin/nologin arzio
mkdir -p /opt/arzio "$DATA" /opt/arzio/backups

# Code: clone once, then follow the branch
if [ ! -d "$APP/.git" ]; then
  git clone --branch "$BRANCH" "$REPO" "$APP"
else
  git -C "$APP" fetch --quiet origin "$BRANCH"
  git -C "$APP" checkout --quiet -B "$BRANCH" FETCH_HEAD
fi
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)

# Settings: written once, kept across updates
if [ ! -f /opt/arzio/arzio.env ]; then
  cat > /opt/arzio/arzio.env <<EOF
ARZIO_SERVICE_NAME="Arzio Mail"
ARZIO_DOMAIN=arzio.local
ARZIO_SIGNUP_MAX_USERS=1
ARZIO_SECRET_KEY=$(openssl rand -hex 32)
HOST=127.0.0.1
PORT=3000
SECURE_COOKIES=true
TRUST_PROXY=true
OUTBOUND_TRANSPORT=log
INBOUND_SMTP_ENABLED=false
IMAP_ENABLED=false
SUBMISSION_ENABLED=false
EOF
  chmod 600 /opt/arzio/arzio.env
fi
chown -R arzio:arzio /opt/arzio

cat > /etc/systemd/system/arzio-mail.service <<EOF
[Unit]
Description=Arzio Mail
After=network-online.target
Wants=network-online.target

[Service]
User=arzio
Group=arzio
WorkingDirectory=$APP
EnvironmentFile=/opt/arzio/arzio.env
Environment=NODE_ENV=production
Environment=ARZIO_DATA_DIR=$DATA
ExecStart=/usr/bin/node --no-warnings src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA /opt/arzio/backups

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
http:// {
  redir https://$HOST{uri} permanent
}
EOF

systemctl daemon-reload
systemctl enable --now arzio-mail
systemctl restart arzio-mail
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/ready >/dev/null && break; sleep 2; done
echo "[arzio] ready at https://$HOST  ($(date -Is))"
