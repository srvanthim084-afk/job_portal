#!/usr/bin/env bash
#
# Issues the first TLS certificate. Run ONCE, before the first real start.
#
#   ./deploy/init-letsencrypt.sh jobs.example.com you@example.com
#
# The chicken-and-egg problem: nginx will not start without a certificate,
# but certbot needs nginx running to answer the ACME challenge. This solves
# it by planting a self-signed placeholder, starting nginx, getting the real
# certificate, then reloading.
#
set -euo pipefail

DOMAIN="${1:?usage: init-letsencrypt.sh <domain> <email> [--staging]}"
EMAIL="${2:?usage: init-letsencrypt.sh <domain> <email> [--staging]}"
STAGING_ARG=""
[ "${3:-}" = "--staging" ] && STAGING_ARG="--staging"

cd "$(dirname "$0")/.."

if grep -q 'jobs.example.com' deploy/nginx/teamlink.conf; then
  echo "deploy/nginx/teamlink.conf still says jobs.example.com."
  echo "Replace it with $DOMAIN in BOTH server blocks first, then re-run."
  exit 1
fi

CERT_PATH="/etc/letsencrypt/live/$DOMAIN"

echo "==> planting a temporary self-signed certificate"
docker compose run --rm --entrypoint sh certbot -c "
  mkdir -p $CERT_PATH &&
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout $CERT_PATH/privkey.pem \
    -out    $CERT_PATH/fullchain.pem \
    -subj '/CN=$DOMAIN' 2>/dev/null"

echo "==> starting nginx"
docker compose up -d nginx
sleep 3

echo "==> removing the placeholder"
docker compose run --rm --entrypoint sh certbot -c "rm -rf $CERT_PATH"

echo "==> requesting the real certificate"
# --staging first if you are testing: Let's Encrypt rate-limits failed
# attempts on a real domain to 5 per hour.
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  $STAGING_ARG \
  --email "$EMAIL" \
  -d "$DOMAIN" \
  --rsa-key-size 4096 \
  --agree-tos \
  --no-eff-email \
  --non-interactive

echo "==> reloading nginx with the real certificate"
docker compose exec nginx nginx -s reload

echo
echo "TLS ready for https://$DOMAIN"
echo "Renewal is automatic — the certbot service checks twice a day."
