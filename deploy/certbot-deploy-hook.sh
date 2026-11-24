#!/bin/sh
# Certbot runs this after each renewal. It copies the certificate where Arzio
# Mail (which does not run as root) can read it, then restarts the service so
# IMAP, SMTP and the MX pick up the new certificate.
#   sudo cp deploy/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/arzio.sh
#   sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/arzio.sh
set -e
HOST="${ARZIO_CERT_HOST:-mail.arzio.com}"
SRC="/etc/letsencrypt/live/$HOST"
DST=/opt/arzio/certs
mkdir -p "$DST"
cp -L "$SRC/fullchain.pem" "$SRC/privkey.pem" "$DST/"
# uid 1000 is the "node" user inside the Docker image; use "arzio" for systemd
chown -R "${ARZIO_CERT_OWNER:-1000}" "$DST"
chmod 600 "$DST/privkey.pem"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q arzio; then
  docker compose -f /opt/arzio/app/deploy/docker-compose.yml restart arzio
  docker compose -f /opt/arzio/app/deploy/docker-compose.yml exec nginx nginx -s reload || true
else
  systemctl restart arzio-mail
  systemctl reload nginx || true
fi
