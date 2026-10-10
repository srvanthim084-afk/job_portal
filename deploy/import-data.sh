#!/usr/bin/env bash
# =====================================================================================
#  TeamLink Job Portal - load the office PC's data into the server's portal (once)
#
#    cd /opt/teamlink-jobs && sudo bash deploy/import-data.sh /root/teamlink-data-for-server-<date>.zip
#
#  The zip comes from EXPORT-DATA-FOR-SERVER.bat on the office PC:
#    teamlink-data.ndjson.gz   the rows (candidates, applications, jobs, settings ...)
#    uploads.tar.gz            resumes, documents, recordings
#    env-from-pc.txt           the PC's settings - used by install-teamlinks.sh, not here
#
#  Run install-teamlinks.sh first (the portal must be up, migrated, same code version).
#
#  It REPLACES the portal's data on this server with the PC's. Nothing else on the server
#  (Enterprise, HRMS, their databases) is touched. A rehearsal (dry run) comes first and
#  you are asked before anything is written; the copy is one transaction - all or nothing.
# =====================================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
COMPOSE=(docker compose -f docker-compose.yml -f deploy/host-nginx.override.yml)
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run it with sudo."
PKG="${1:-}"
[ -n "$PKG" ] && [ -e "$PKG" ] || die "usage: sudo bash deploy/import-data.sh <teamlink-data-for-server-....zip or its unzipped folder>"

WORK=$(mktemp -d /tmp/teamlink-import.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
if [ -d "$PKG" ]; then cp -r "$PKG"/. "$WORK"/;
else
  command -v unzip >/dev/null || apt-get install -y unzip >/dev/null
  unzip -q "$PKG" -d "$WORK"
fi
[ -f "$WORK/teamlink-data.ndjson.gz" ] || die "teamlink-data.ndjson.gz is not in the package."
chmod -R a+rX "$WORK"

curl -fsS http://127.0.0.1:4323/api/health >/dev/null 2>&1 || die "the portal is not running - run deploy/install-teamlinks.sh first."

# the tool runs inside the portal's own image (it has `pg`); placed beside api/node_modules
RUN=("${COMPOSE[@]}" run --rm --no-deps -T
     -v "$HERE/tools/copy-live-to-postgres.mjs:/app/api/copy-live-to-postgres.mjs:ro"
     -v "$WORK:/data:ro"
     --entrypoint node migrate /app/api/copy-live-to-postgres.mjs --from-file /data/teamlink-data.ndjson.gz)

say "1/4  Rehearsal (nothing is written)"
"${RUN[@]}" --dry-run || die "the rehearsal failed - nothing was changed. See the message above."

echo
read -r -p "Replace the portal data on THIS server with the office PC's data? Type COPY to go on: " answer
[ "$answer" = "COPY" ] || die "not confirmed - nothing was changed."

say "2/4  Stopping the portal API while the data is loaded"
"${COMPOSE[@]}" stop api

say "3/4  Loading the data (one transaction)"
if ! "${RUN[@]}"; then
  "${COMPOSE[@]}" start api
  die "the copy failed and was rolled back - the server's data is as it was. The portal is running again."
fi

if [ -f "$WORK/uploads.tar.gz" ]; then
  say "     ... and the uploaded files"
  mkdir -p "$WORK/u" && tar -xzf "$WORK/uploads.tar.gz" -C "$WORK/u"
  "${COMPOSE[@]}" start api
  docker compose -f docker-compose.yml -f deploy/host-nginx.override.yml cp "$WORK/u/uploads/." api:/app/var/uploads/
  "${COMPOSE[@]}" exec -T -u root api chown -R teamlink:teamlink /app/var/uploads
else
  echo "    (no uploads.tar.gz in the package - skipped)"
fi

say "4/4  Starting the portal"
"${COMPOSE[@]}" up -d api
for i in $(seq 1 40); do curl -fsS http://127.0.0.1:4323/api/health >/dev/null 2>&1 && break; sleep 3; done
curl -fsS http://127.0.0.1:4323/api/health >/dev/null 2>&1 || die "the portal did not come back - check: docker compose logs --tail=80 api"
echo
echo "Done. The office PC's data is on the server. Sign in with the same email and password as on the PC."
