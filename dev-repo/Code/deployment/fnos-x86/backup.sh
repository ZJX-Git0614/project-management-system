#!/bin/sh
set -eu
cd "$(dirname "$0")"

APP_IMAGE="ceastar-project-management:2026.07.30.3-amd64"
DOCUMENT_VOLUME="ceastar-pms_document_storage"
timestamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="$(pwd)/backups/manual-${timestamp}"

mkdir -p "$backup_dir"
configured_document_volume="$(sed -n 's/^PMS_DOCUMENT_VOLUME=//p' .env | tail -1)"
[ -n "$configured_document_volume" ] && DOCUMENT_VOLUME="$configured_document_volume"
postgres_container="$(docker compose ps -q postgres)"
[ -n "$postgres_container" ] || { printf 'PostgreSQL is not running.\n' >&2; exit 1; }

printf 'Backing up PostgreSQL...\n'
docker exec "$postgres_container" pg_dump -U pms -d pms -Fc -f /tmp/database.dump
docker cp "$postgres_container:/tmp/database.dump" "$backup_dir/database.dump"
docker exec "$postgres_container" rm -f /tmp/database.dump

printf 'Backing up project documents...\n'
docker run --rm \
  --platform linux/amd64 \
  --entrypoint sh \
  -v "$DOCUMENT_VOLUME:/source:ro" \
  -v "$backup_dir:/output" \
  "$APP_IMAGE" \
  -c "tar -czf /output/project-documents.tar.gz -C /source ."

sha256sum "$backup_dir/database.dump" "$backup_dir/project-documents.tar.gz" > "$backup_dir/SHA256SUMS.txt"
printf 'Backup completed: %s\n' "$backup_dir"
