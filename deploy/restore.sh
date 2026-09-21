#!/usr/bin/env bash
#
# Restores a backup produced by deploy/backup.sh.
#
#   ./deploy/restore.sh var/backups/db-20260921T030000Z.dump
#
# A backup you have never restored is not a backup. Practise this on a
# staging box before you need it in anger.
#
set -euo pipefail

DUMP="${1:?usage: restore.sh <db-dump-file> [uploads-tar]}"
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 1; }

cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DB_NAME="${POSTGRES_DB:-teamlink}"
DB_USER="${POSTGRES_USER:-postgres}"

# Derive the matching uploads archive from the dump's timestamp unless one
# was given — restoring mismatched pairs is the failure mode to avoid.
STAMP="$(basename "$DUMP" | sed -n 's/^db-\(.*\)\.dump$/\1/p')"
UPLOADS="${2:-$(dirname "$DUMP")/uploads-$STAMP.tar.gz}"

echo
echo "  database : $DUMP"
echo "  uploads  : $([ -f "$UPLOADS" ] && echo "$UPLOADS" || echo '(none found)')"
echo
echo "This REPLACES the contents of database '$DB_NAME'. Current data will be lost."
printf "Type the database name to confirm: "
read -r CONFIRM
[ "$CONFIRM" = "$DB_NAME" ] || { echo "aborted"; exit 1; }

echo "stopping the API so nothing writes mid-restore"
docker compose stop api >/dev/null

echo "restoring database"
# --clean --if-exists drops objects first; a plain restore over a populated
# schema fails on every primary key.
docker compose exec -T db \
  pg_restore --clean --if-exists --no-owner --no-acl \
  -U "$DB_USER" -d "$DB_NAME" < "$DUMP"

if [ -f "$UPLOADS" ]; then
  echo "restoring uploaded resumes"
  docker compose run --rm --no-deps \
    -v "$(pwd)/$(dirname "$UPLOADS"):/backup" \
    --entrypoint sh api \
    -c "rm -rf /app/var/uploads/* && tar xzf /backup/$(basename "$UPLOADS") -C /app/var" \
    >/dev/null
else
  echo "WARNING: no uploads archive — resume records will point at missing files"
fi

echo "re-applying migrations (in case the dump predates the current build)"
docker compose run --rm migrate >/dev/null

echo "starting the API"
docker compose up -d api >/dev/null

echo "waiting for health"
for i in $(seq 1 30); do
  if docker compose exec -T api curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    echo "restore complete — API healthy"
    exit 0
  fi
  sleep 2
done

echo "API did not become healthy; check: docker compose logs api" >&2
exit 1
