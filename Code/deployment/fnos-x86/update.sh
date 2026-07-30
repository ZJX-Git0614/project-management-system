#!/bin/sh
set -eu

PACKAGE_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
IMAGE_FILE="$PACKAGE_DIR/images/ceastar-pms-linux-amd64.tar"
IMAGE_NAME_FILE="$PACKAGE_DIR/image-name.txt"
CHECKSUM_FILE="$PACKAGE_DIR/image.sha256"
STATE_FILE_NAME=".ceastar-fnos-update.state"

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required to verify the update image."
  fi
}

set_env_value() {
  key="$1"
  value="$2"
  file="$3"
  if grep -q "^${key}=" "$file"; then
    escaped_value="$(printf '%s' "$value" | sed 's/[&|]/\\&/g')"
    sed -i.bak "s|^${key}=.*|${key}=${escaped_value}|" "$file"
    rm -f "$file.bak"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

wait_for_application() {
  attempt=1
  while [ "$attempt" -le 120 ]; do
    container="$(docker compose ps -q pms)"
    if [ -n "$container" ] && docker exec "$container" node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

find_deployment_dir() {
  if [ "$#" -ge 1 ] && [ -n "$1" ]; then
    candidate="$1"
    [ -f "$candidate/docker-compose.yml" ] || fail "The specified directory does not contain docker-compose.yml: $candidate"
    CDPATH= cd -- "$candidate" && pwd
    return
  fi

  for candidate in "$PACKAGE_DIR/.." "$PACKAGE_DIR/../.."; do
    if [ -f "$candidate/docker-compose.yml" ]; then
      CDPATH= cd -- "$candidate" && pwd
      return
    fi
  done
  fail "Deployment directory not found. Place this update folder inside the Ceastar PMS deployment directory, or run: ./update.sh /path/to/deployment"
}

case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "This update supports x86_64/amd64 fnOS devices only. Current architecture: $(uname -m)" ;;
esac

command -v docker >/dev/null 2>&1 || fail "Docker is not installed or is not available in PATH."
docker info >/dev/null 2>&1 || fail "Docker is not running, or the current account cannot access Docker."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is unavailable."
[ -f "$IMAGE_FILE" ] || fail "Missing update image: $IMAGE_FILE"
[ -f "$IMAGE_NAME_FILE" ] || fail "Missing image-name.txt"
[ -f "$CHECKSUM_FILE" ] || fail "Missing image.sha256"

NEW_IMAGE="$(tr -d '\r\n' < "$IMAGE_NAME_FILE")"
EXPECTED_CHECKSUM="$(awk '{print $1}' "$CHECKSUM_FILE" | tr 'A-F' 'a-f')"
ACTUAL_CHECKSUM="$(checksum "$IMAGE_FILE" | tr 'A-F' 'a-f')"
[ -n "$NEW_IMAGE" ] || fail "image-name.txt is empty."
[ "$EXPECTED_CHECKSUM" = "$ACTUAL_CHECKSUM" ] || fail "The update image checksum does not match. Copy the complete update package again."

DEPLOY_DIR="$(find_deployment_dir "${1:-}")"
cd "$DEPLOY_DIR"
[ -f .env ] || fail "The deployment .env file is missing."

PMS_CONTAINER="$(docker compose ps -q pms)"
[ -n "$PMS_CONTAINER" ] || fail "The pms container is not running. Start the existing deployment before updating."
OLD_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$PMS_CONTAINER")"
[ -n "$OLD_IMAGE" ] || fail "Cannot determine the current Ceastar PMS image."

printf 'Creating a database and document backup...\n'
[ -x ./backup.sh ] || chmod +x ./backup.sh
./backup.sh

printf 'Loading the verified linux/amd64 update image...\n'
docker load --input "$IMAGE_FILE"
docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || fail "The update image was not loaded correctly."
IMAGE_ARCH="$(docker image inspect --format '{{.Architecture}}' "$NEW_IMAGE")"
[ "$IMAGE_ARCH" = "amd64" ] || fail "The loaded image architecture is $IMAGE_ARCH, expected amd64."

cp docker-compose.yml "docker-compose.yml.pre-update"
if grep -q 'image:.*ceastar-project-management:' docker-compose.yml; then
  sed -i.bak 's|^[[:space:]]*image:.*ceastar-project-management:.*|    image: ${PMS_APP_IMAGE}|' docker-compose.yml
  rm -f docker-compose.yml.bak
fi
set_env_value PMS_APP_IMAGE "$NEW_IMAGE" .env
docker compose config >/dev/null || fail "The updated docker-compose.yml is invalid."

cat > "$STATE_FILE_NAME" <<EOF
OLD_IMAGE=${OLD_IMAGE}
NEW_IMAGE=${NEW_IMAGE}
UPDATED_AT=$(date '+%Y-%m-%d %H:%M:%S')
EOF

printf 'Recreating only the Ceastar PMS application container...\n'
docker compose up -d --no-deps --force-recreate pms
if ! wait_for_application; then
  docker compose logs --tail=200 pms
  printf '\nThe new application did not become ready. Restoring the previous image...\n' >&2
  set_env_value PMS_APP_IMAGE "$OLD_IMAGE" .env
  docker compose up -d --no-deps --force-recreate pms
  fail "Update failed and the previous application image was restored. The pre-update backup remains in the backups directory."
fi

printf '\nCeastar PMS fnOS update completed successfully.\n'
printf 'Previous image retained for rollback: %s\n' "$OLD_IMAGE"
printf "%s\n" "Run this package's rollback-update.sh if application rollback is required."
