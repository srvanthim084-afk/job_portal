#!/usr/bin/env bash
# =====================================================================================
#  TeamLink Job Portal - install / update on the TeamLink server (72.61.233.104)
#
#    cd /opt/teamlink-jobs && sudo bash deploy/install-teamlinks.sh
#
#  What it does (safe to run again - it is also the UPDATE command):
#    1. checks Docker, the compose plugin and nginx;
#    2. prepares .env  (from env-from-pc.txt if it is in this folder; generates the
#       database passwords and AUTH_SECRET if they are missing; PUBLIC_ORIGIN = the domain);
#    3. builds and starts the portal - database + migrations + API only, the API on
#       127.0.0.1:4323 (never the bundled nginx: this server's nginx owns ports 80/443);
#    4. adds nginx site  jobs.teamlinks.in -> 127.0.0.1:4323  and asks certbot for HTTPS.
#
#  What it never does: touch TeamLink Enterprise (4010), HRMS (4000), their databases,
#  or the existing teamlink.teamlinks.in nginx site. The /jobs/ redirect on that site is
#  one small edit printed at the end, for you to make (docs/DEPLOY-TEAMLINKS-SERVER.md).
# =====================================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-jobs.teamlinks.in}"
PORT_LOCAL=4323
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
COMPOSE=(docker compose -f docker-compose.yml -f deploy/host-nginx.override.yml)

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run it with sudo (it adds an nginx site)."
[ -f docker-compose.yml ] && [ -f deploy/host-nginx.override.yml ] || die "run it from the portal's folder (git clone of job_portal)."

say "1/4  Checking the server"
command -v docker >/dev/null || die "Docker is not installed:  curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || die "the Docker compose plugin is missing:  apt-get install -y docker-compose-plugin"
command -v nginx >/dev/null || die "nginx was not found - this script expects the server's own nginx."
if ss -ltn 2>/dev/null | grep -q "127.0.0.1:${PORT_LOCAL} \|0.0.0.0:${PORT_LOCAL} \|\*:${PORT_LOCAL} " \
   && ! "${COMPOSE[@]}" ps --status running api 2>/dev/null | grep -q api; then
  die "port ${PORT_LOCAL} is already used by something else on this server."
fi
ok "docker $(docker --version | awk '{print $3}' | tr -d ,), nginx present, port ${PORT_LOCAL} free for the portal"

say "2/4  Settings (.env)"
setv() {  # setv KEY VALUE  - replace or append, without printing the value
  local k="$1" v="$2"
  if grep -q "^${k}=" .env; then
    local esc; esc=$(printf '%s' "$v" | sed -e 's/[\/&|]/\\&/g')
    sed -i "s|^${k}=.*|${k}=${esc}|" .env
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}
getv() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r'; }
if [ ! -f .env ]; then
  if [ -f env-from-pc.txt ]; then cp env-from-pc.txt .env; ok "started from env-from-pc.txt (the office PC's settings)";
  else cp .env.example .env; ok "started from .env.example - copy env-from-pc.txt here first to keep email and integrations working"; fi
fi
sed -i 's/\r$//' .env
chmod 600 .env
setv PUBLIC_ORIGIN "https://${DOMAIN}"
setv LOAD_SEED false          # never the demo data on the server
[ -n "$(getv POSTGRES_PASSWORD)" ] || { setv POSTGRES_PASSWORD "$(openssl rand -hex 24)"; ok "generated POSTGRES_PASSWORD"; }
[ -n "$(getv APP_DB_PASSWORD)" ]   || { setv APP_DB_PASSWORD "$(openssl rand -hex 24)";   ok "generated APP_DB_PASSWORD"; }
[ -n "$(getv AUTH_SECRET)" ]       || { setv AUTH_SECRET "$(openssl rand -hex 32)";       ok "generated AUTH_SECRET"; }
if [ -z "$(getv INTEGRATION_SECRET_KEY)" ]; then
  printf '    \033[33mINTEGRATION_SECRET_KEY is empty: saved integration passwords from the PC (Naukri/Shine mailboxes) will not open.\n    Put the PC'"'"'s value in .env (from env-from-pc.txt) and run this script again.\033[0m\n'
fi
ok ".env ready (PUBLIC_ORIGIN=https://${DOMAIN}); values are not printed"

say "3/4  Building and starting the portal (database, migrations, API)"
"${COMPOSE[@]}" up -d --build db migrate api
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT_LOCAL}/api/health" >/dev/null 2>&1; then break; fi
  sleep 3
done
curl -fsS "http://127.0.0.1:${PORT_LOCAL}/api/health" >/dev/null 2>&1 || { "${COMPOSE[@]}" logs --tail=60 api migrate; die "the portal did not answer on 127.0.0.1:${PORT_LOCAL} - logs above."; }
ok "portal answering on 127.0.0.1:${PORT_LOCAL}"

say "4/4  nginx site ${DOMAIN}"
SITE=/etc/nginx/sites-available/${DOMAIN}
if [ -d /etc/nginx/sites-available ]; then
  if [ ! -f "$SITE" ]; then
    sed "s/jobs\.teamlinks\.in/${DOMAIN}/g" deploy/nginx/jobs.teamlinks.in.conf > "$SITE"
    ln -sf "$SITE" /etc/nginx/sites-enabled/${DOMAIN}
    ok "added $SITE"
  else
    ok "$SITE already there - left as it is"
  fi
else
  SITE=/etc/nginx/conf.d/${DOMAIN}.conf
  [ -f "$SITE" ] || sed "s/jobs\.teamlinks\.in/${DOMAIN}/g" deploy/nginx/jobs.teamlinks.in.conf > "$SITE"
  ok "using $SITE"
fi
nginx -t || die "nginx refused the configuration - nothing was reloaded. Remove $SITE to undo."
systemctl reload nginx
ok "nginx reloaded"

IP_SELF=$(curl -fsS -4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
IP_DNS=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -z "$IP_DNS" ]; then
  printf '    \033[33m%s does not resolve yet. Add the DNS A record  %s -> %s , wait, then run:  sudo certbot --nginx -d %s\033[0m\n' "$DOMAIN" "$DOMAIN" "$IP_SELF" "$DOMAIN"
elif command -v certbot >/dev/null; then
  if certbot certificates 2>/dev/null | grep -q "Domains: .*${DOMAIN}"; then ok "HTTPS certificate already there";
  else certbot --nginx -d "$DOMAIN" || printf '    \033[33mcertbot did not finish - run it again:  sudo certbot --nginx -d %s\033[0m\n' "$DOMAIN"; fi
else
  printf '    \033[33mcertbot is not installed:  apt-get install -y certbot python3-certbot-nginx  &&  certbot --nginx -d %s\033[0m\n' "$DOMAIN"
fi

cat <<EOF

=====================================================================================
 The portal is installed:  https://${DOMAIN}

 NEXT
  1. Data from the office PC (once):  sudo bash deploy/import-data.sh <path to teamlink-data-for-server-....zip>
  2. The old link -> the portal: in the EXISTING teamlink.teamlinks.in nginx site, comment out the block
     that serves /jobs/ today and add:
         location /jobs/ { return 302 https://${DOMAIN}/; }
         location = /jobs { return 302 https://${DOMAIN}/; }
     then:  sudo nginx -t && sudo systemctl reload nginx
  3. Later updates:  cd ${HERE} && git pull && sudo bash deploy/install-teamlinks.sh
=====================================================================================
EOF
