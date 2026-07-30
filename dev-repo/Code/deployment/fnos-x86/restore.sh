#!/bin/sh
set -eu
cd "$(dirname "$0")"

APP_IMAGE="ceastar-project-management:2026.07.30.3-amd64"
DOCUMENT_VOLUME="ceastar-pms_document_storage"

if [ "$#" -ne 2 ] || [ "$2" != "RESTORE" ]; then
  printf 'Usage: ./restore.sh backups/manual-YYYYMMDD-HHMMSS RESTORE\n' >&2
  printf 'This operation replaces the current database and project documents.\n' >&2
  exit 1
fi

backup_dir="$(cd "$1" && pwd)"
[ -f "$backup_dir/database.dump" ] || { printf 'Missing database.dump\n' >&2; exit 1; }
[ -f "$backup_dir/project-documents.tar.gz" ] || { printf 'Missing project-documents.tar.gz\n' >&2; exit 1; }

printf 'Creating a protection backup before restore...\n'
./backup.sh

configured_document_volume="$(sed -n 's/^PMS_DOCUMENT_VOLUME=//p' .env | tail -1)"
[ -n "$configured_document_volume" ] && DOCUMENT_VOLUME="$configured_document_volume"
postgres_container="$(docker compose ps -q postgres)"
[ -n "$postgres_container" ] || { printf 'PostgreSQL is not running.\n' >&2; exit 1; }

docker compose stop pms
docker cp "$backup_dir/database.dump" "$postgres_container:/tmp/database.dump"
docker exec "$postgres_container" dropdb -U pms --if-exists --force pms
docker exec "$postgres_container" createdb -U pms -O pms pms
docker exec "$postgres_container" pg_restore -U pms -d pms --exit-on-error --no-owner --no-privileges /tmp/database.dump
docker exec "$postgres_container" rm -f /tmp/database.dump

docker run --rm \
  --platform linux/amd64 \
  --entrypoint sh \
  -v "$DOCUMENT_VOLUME:/target" \
  -v "$backup_dir:/source:ro" \
  "$APP_IMAGE" \
  -c "rm -rf /target/* && tar -xzf /source/project-documents.tar.gz -C /target"

docker compose up -d pms
printf 'Restore completed. Run ./status.sh to confirm service health.\n'
