#!/bin/sh
set -eu

cd "$(dirname "$0")"

APP_IMAGE="ceastar-project-management:2026.07.30.4-amd64"
POSTGRES_IMAGE="postgres:16-alpine"
APP_IMAGE_FILE="images/ceastar-pms-linux-amd64.tar"
POSTGRES_IMAGE_FILE="images/postgres-16-alpine-linux-amd64.tar"
DATABASE_DUMP="data/database.dump"
DOCUMENT_ARCHIVE="data/project-documents.tar.gz"
PROJECT_VOLUME="ceastar-pms_document_storage"
DATABASE_VOLUME="ceastar-pms_pgdata"

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

wait_for_postgres() {
  printf 'Waiting for PostgreSQL...\n'
  attempt=1
  stable_checks=0
  while [ "$attempt" -le 90 ]; do
    postgres_container="$(docker compose ps -q postgres)"
    if [ -n "$postgres_container" ] && docker exec "$postgres_container" pg_isready -U pms -d pms >/dev/null 2>&1; then
      stable_checks=$((stable_checks + 1))
      if [ "$stable_checks" -ge 3 ]; then
        return 0
      fi
    else
      stable_checks=0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

wait_for_application() {
  printf 'Waiting for Ceastar PMS...\n'
  attempt=1
  while [ "$attempt" -le 120 ]; do
    app_container="$(docker compose ps -q pms)"
    if [ -n "$app_container" ] && docker exec "$app_container" node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "This offline package supports x86_64/amd64 fnOS devices only. Current architecture: $(uname -m)" ;;
esac

command -v docker >/dev/null 2>&1 || fail "Docker is not installed or is not available in PATH."
docker info >/dev/null 2>&1 || fail "Docker is not running, or the current account cannot access Docker."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is unavailable."

for required_file in docker-compose.yml "$APP_IMAGE_FILE" "$POSTGRES_IMAGE_FILE" "$DATABASE_DUMP" "$DOCUMENT_ARCHIVE"; do
  [ -f "$required_file" ] || fail "Missing deployment file: $required_file"
done

if [ -f .installed ]; then
  printf 'Ceastar PMS is already installed from this directory. Starting the existing deployment...\n'
  docker compose up -d
  printf 'Started. Open http://FNOS-IP:%s\n' "${PMS_PORT:-3000}"
  exit 0
fi

if [ ! -f .env ]; then
  umask 077
  database_password="$(random_hex)"
  jwt_secret="$(random_hex)"
  cat > .env <<EOF
POSTGRES_PASSWORD=${database_password}
JWT_SECRET=${jwt_secret}
PMS_PORT=3000
PMS_WEB_WORKERS=4
PMS_APP_IMAGE=${APP_IMAGE}
PMS_DATABASE_VOLUME=ceastar-pms_pgdata
PMS_DOCUMENT_VOLUME=ceastar-pms_document_storage
EOF
  printf 'Generated a private .env configuration.\n'
fi

configured_database_volume="$(sed -n 's/^PMS_DATABASE_VOLUME=//p' .env | tail -1)"
configured_document_volume="$(sed -n 's/^PMS_DOCUMENT_VOLUME=//p' .env | tail -1)"
[ -n "$configured_database_volume" ] && DATABASE_VOLUME="$configured_database_volume"
[ -n "$configured_document_volume" ] && PROJECT_VOLUME="$configured_document_volume"

if docker volume inspect "$DATABASE_VOLUME" >/dev/null 2>&1 && [ ! -f .installing ]; then
  fail "An existing Ceastar PMS database volume was found. Installation stopped to protect existing data."
fi

touch .installing
mkdir -p backups

printf 'Loading offline Docker images...\n'
docker load --input "$POSTGRES_IMAGE_FILE"
docker load --input "$APP_IMAGE_FILE"

docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1 || fail "The PostgreSQL image was not loaded correctly."
docker image inspect "$APP_IMAGE" >/dev/null 2>&1 || fail "The Ceastar PMS image was not loaded correctly."

printf 'Starting PostgreSQL...\n'
docker compose up -d postgres
wait_for_postgres || fail "PostgreSQL did not become ready. Run ./logs.sh to inspect the error."
postgres_container="$(docker compose ps -q postgres)"
[ -n "$postgres_container" ] || fail "The PostgreSQL container was not created."

printf 'Restoring the packaged database...\n'
docker cp "$DATABASE_DUMP" "$postgres_container:/tmp/database.dump"
docker exec "$postgres_container" dropdb -U pms --if-exists --force pms
docker exec "$postgres_container" createdb -U pms -O pms pms
docker exec "$postgres_container" pg_restore -U pms -d pms --exit-on-error --no-owner --no-privileges /tmp/database.dump
docker exec "$postgres_container" rm -f /tmp/database.dump

printf 'Restoring uploaded project documents...\n'
docker volume create "$PROJECT_VOLUME" >/dev/null
package_dir="$(pwd)"
docker run --rm \
  --platform linux/amd64 \
  --entrypoint sh \
  -v "$PROJECT_VOLUME:/target" \
  -v "$package_dir/data:/source:ro" \
  "$APP_IMAGE" \
  -c "rm -rf /target/* /tmp/document-restore && mkdir -p /tmp/document-restore && tar -xzf /source/project-documents.tar.gz -C /tmp/document-restore && if [ -d /tmp/document-restore/project-documents ]; then cp -a /tmp/document-restore/project-documents/. /target/; else cp -a /tmp/document-restore/. /target/; fi && find /target \( -name '._*' -o -name '.DS_Store' \) -exec rm -f {} +"

printf 'Starting Ceastar PMS and applying compatible database migrations...\n'
docker compose up -d pms
if ! wait_for_application; then
  docker compose logs --tail=200 pms postgres
  fail "Ceastar PMS did not become ready. The recent logs are shown above."
fi

rm -f .installing
date '+%Y-%m-%d %H:%M:%S' > .installed

lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
port="$(sed -n 's/^PMS_PORT=//p' .env | tail -1)"
[ -n "$port" ] || port=3000

printf '\nInstallation completed.\n'
if [ -n "$lan_ip" ]; then
  printf 'Open: http://%s:%s\n' "$lan_ip" "$port"
else
  printf 'Open: http://FNOS-IP:%s\n' "$port"
fi
printf 'Use ./status.sh to check service status and ./backup.sh to create a manual backup.\n'
