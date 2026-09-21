#!/usr/bin/env bash
#
# Backs up the database AND the uploaded resumes.
#
# Backing up only Postgres is a common and painful mistake here: resume
# files live on a docker volume, not in the database, so a database-only
# restore would bring back every candidate record with a dead file
# reference. Both are captured together, with the same timestamp.
#
#   ./deploy/backup.sh [destination-dir]
#
# Cron it daily:
#   0 3 * * * cd /srv/teamlink && ./deploy/backup.sh >> var/backup.log 2>&1
#
set -euo pipefail

DEST="${1:-./var/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

cd "$(dirname "$0")/.."
mkdir -p "$DEST"

if [ -f .env ]; then set -a; . ./.env; set +a; fi
DB_NAME="${POSTGRES_DB:-teamlink}"
DB_USER="${POSTGRES_USER:-postgres}"

echo "[$(date -u +%H:%M:%S)] backing up database '$DB_NAME'"

# --format=custom so pg_restore can do selective restores and parallelism.
docker compose exec -T db \
  pg_dump --format=custom --no-owner --no-acl -U "$DB_USER" "$DB_NAME" \
  > "$DEST/db-$STAMP.dump"

DB_BYTES=$(wc -c < "$DEST/db-$STAMP.dump")
if [ "$DB_BYTES" -lt 1024 ]; then
  echo "ERROR: dump is only ${DB_BYTES} bytes — treating as a failure" >&2
  rm -f "$DEST/db-$STAMP.dump"
  exit 1
fi

echo "[$(date -u +%H:%M:%S)] backing up uploaded resumes"
docker compose run --rm --no-deps \
  -v "$(pwd)/$DEST:/backup" \
  --entrypoint sh api \
  -c 'tar czf /backup/uploads-'"$STAMP"'.tar.gz -C /app/var uploads' \
  >/dev/null

# Record what produced this backup, so a restore onto the wrong build is
# obvious rather than mysterious.
docker compose exec -T db psql -qtA -U "$DB_USER" -d "$DB_NAME" \
  -c 'select filename from schema_migrations order by filename' \
  > "$DEST/schema-$STAMP.txt"

echo "[$(date -u +%H:%M:%S)] done"
ls -lh "$DEST"/*"$STAMP"* | sed 's/^/  /'

# Prune old backups LAST, so a failure above never deletes anything.
find "$DEST" -maxdepth 1 -name 'db-*.dump'        -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -name 'uploads-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -name 'schema-*.txt'     -mtime "+$KEEP_DAYS" -delete
echo "  retention: ${KEEP_DAYS} days"
