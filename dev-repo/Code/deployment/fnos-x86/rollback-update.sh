#!/bin/sh
set -eu

PACKAGE_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
STATE_FILE_NAME=".ceastar-fnos-update.state"

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

set_env_value() {
  key="$1"
  value="$2"
  file="$3"
  escaped_value="$(printf '%s' "$value" | sed 's/[&|]/\\&/g')"
  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s|^${key}=.*|${key}=${escaped_value}|" "$file"
    rm -f "$file.bak"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
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
  fail "Deployment directory not found."
}

DEPLOY_DIR="$(find_deployment_dir "${1:-}")"
cd "$DEPLOY_DIR"
[ -f "$STATE_FILE_NAME" ] || fail "No update state was found; application rollback cannot be determined automatically."
[ -f .env ] || fail "The deployment .env file is missing."

OLD_IMAGE="$(sed -n 's/^OLD_IMAGE=//p' "$STATE_FILE_NAME" | tail -1)"
[ -n "$OLD_IMAGE" ] || fail "The rollback image is missing from $STATE_FILE_NAME."
docker image inspect "$OLD_IMAGE" >/dev/null 2>&1 || fail "The previous image is no longer available: $OLD_IMAGE"

printf 'Rolling back the application container to %s...\n' "$OLD_IMAGE"
set_env_value PMS_APP_IMAGE "$OLD_IMAGE" .env
docker compose up -d --no-deps --force-recreate pms
docker compose ps pms
printf '\nApplication image rollback completed. Database and documents were not modified.\n'
printf 'If data restoration is required, use the deployment restore.sh with the pre-update backup.\n'
