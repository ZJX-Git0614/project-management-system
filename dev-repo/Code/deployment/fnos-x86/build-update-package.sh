#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
RELEASE_VERSION="${1:-2026.07.30.4}"
RELEASE_STAMP="$(printf '%s' "$RELEASE_VERSION" | sed -E 's/^([0-9]{4})\.([0-9]{2})\.([0-9]{2})\.(.+)$/\1\2\3-\4/')"
IMAGE_NAME="ceastar-project-management:${RELEASE_VERSION}-amd64"
OUTPUT_ROOT="${2:-$REPO_DIR/../../outputs/fnos-update}"
DATA_UPDATE_SQL="${3:-}"
PACKAGE_NAME="Ceastar-PMS-fnOS-Update-${RELEASE_STAMP}"
PACKAGE_DIR="$OUTPUT_ROOT/$PACKAGE_NAME"
IMAGE_FILE="$PACKAGE_DIR/images/ceastar-pms-linux-amd64.tar"
DATA_UPDATE_FILE="$PACKAGE_DIR/database/update.sql"

command -v docker >/dev/null 2>&1 || { printf 'Docker is required.\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf 'Docker is not running.\n' >&2; exit 1; }

rm -rf "$PACKAGE_DIR" "$OUTPUT_ROOT/$PACKAGE_NAME.zip"
mkdir -p "$PACKAGE_DIR/images"

printf 'Building %s for linux/amd64...\n' "$IMAGE_NAME"
docker buildx build --platform linux/amd64 --tag "$IMAGE_NAME" --load "$REPO_DIR"

printf 'Saving the offline update image...\n'
docker save --output "$IMAGE_FILE" "$IMAGE_NAME"
printf '%s\n' "$IMAGE_NAME" > "$PACKAGE_DIR/image-name.txt"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$IMAGE_FILE" | awk '{print $1}' > "$PACKAGE_DIR/image.sha256"
else
  shasum -a 256 "$IMAGE_FILE" | awk '{print $1}' > "$PACKAGE_DIR/image.sha256"
fi

if [ -n "$DATA_UPDATE_SQL" ]; then
  [ -f "$DATA_UPDATE_SQL" ] || { printf 'Data update SQL does not exist: %s\n' "$DATA_UPDATE_SQL" >&2; exit 1; }
  mkdir -p "$PACKAGE_DIR/database"
  cp "$DATA_UPDATE_SQL" "$DATA_UPDATE_FILE"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$DATA_UPDATE_FILE" | awk '{print $1}' > "$PACKAGE_DIR/database/update.sha256"
  else
    shasum -a 256 "$DATA_UPDATE_FILE" | awk '{print $1}' > "$PACKAGE_DIR/database/update.sha256"
  fi
fi

cp "$SCRIPT_DIR/update.sh" "$SCRIPT_DIR/rollback-update.sh" "$SCRIPT_DIR/UPDATE-README.txt" "$PACKAGE_DIR/"
chmod +x "$PACKAGE_DIR/update.sh" "$PACKAGE_DIR/rollback-update.sh"

(
  cd "$OUTPUT_ROOT"
  zip -qry "$PACKAGE_NAME.zip" "$PACKAGE_NAME"
)

printf 'Verifying ZIP...\n'
unzip -tq "$OUTPUT_ROOT/$PACKAGE_NAME.zip" >/dev/null
printf 'Update package created: %s\n' "$OUTPUT_ROOT/$PACKAGE_NAME.zip"
