#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_ROOT="${1:-$REPO_DIR/dist/releases/windows-x86}"
IMAGE_NAME="$(tr -d '\r\n' < "$SCRIPT_DIR/image-name.txt")"
RELEASE_ID="$(tr -d '\r\n' < "$SCRIPT_DIR/release-id.txt")"
COMPATIBLE_BASE_RELEASE="20260806-4"
SKIP_SOURCE_VERIFY="${SKIP_SOURCE_VERIFY:-0}"
SKIP_IMAGE_BUILD="${SKIP_IMAGE_BUILD:-0}"

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required."
}

case "$IMAGE_NAME" in
  ceastar-project-management:*-amd64) ;;
  *) fail "image-name.txt must contain ceastar-project-management:<version>-amd64." ;;
esac

printf '%s' "$RELEASE_ID" | grep -Eq '^[0-9]{8}-[0-9A-Za-z.-]+$' || \
  fail "release-id.txt must look like 20260804-1."

RELEASE_VERSION="${IMAGE_NAME#ceastar-project-management:}"
RELEASE_VERSION="${RELEASE_VERSION%-amd64}"
PACKAGE_NAME="Ceastar-PMS-Update-${RELEASE_ID}-blue-green"
FINAL_ZIP="$OUTPUT_ROOT/$PACKAGE_NAME.zip"
FINAL_ZIP_HASH="$FINAL_ZIP.sha256"

for command_name in docker git npm perl shasum unzip zip; do
  require_command "$command_name"
done

docker info >/dev/null 2>&1 || fail "Docker is not running."
docker buildx version >/dev/null 2>&1 || fail "Docker Buildx is unavailable."

mkdir -p "$OUTPUT_ROOT"
if [ -e "$FINAL_ZIP" ] || [ -e "$FINAL_ZIP_HASH" ]; then
  fail "Release output already exists: $FINAL_ZIP"
fi

TEMP_ROOT="$(mktemp -d "$OUTPUT_ROOT/.ceastar-windows-release.XXXXXX")"
PACKAGE_DIR="$TEMP_ROOT/$PACKAGE_NAME"
IMAGE_DIR="$PACKAGE_DIR/images"
IMAGE_FILE="$IMAGE_DIR/ceastar-pms-${RELEASE_VERSION}-amd64.tar"
ZIP_FILE="$TEMP_ROOT/$PACKAGE_NAME.zip"

cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

if [ "$SKIP_SOURCE_VERIFY" != "1" ]; then
  printf '\n[1/6] Verifying the source tree...\n'
  (
    cd "$REPO_DIR"
    npm test
    npm run lint
    npm run typecheck
    npm run build
    git diff --check
  )
else
  printf '\n[1/6] Source verification skipped by SKIP_SOURCE_VERIFY=1.\n'
fi

if [ "$SKIP_IMAGE_BUILD" != "1" ]; then
  printf '\n[2/6] Building %s for linux/amd64...\n' "$IMAGE_NAME"
  docker buildx build \
    --platform linux/amd64 \
    --tag "$IMAGE_NAME" \
    --load \
    "$REPO_DIR"
else
  printf '\n[2/6] Image build skipped by SKIP_IMAGE_BUILD=1.\n'
fi

printf '\n[3/6] Verifying image platform and runtime contents...\n'
docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 || fail "Built image is missing: $IMAGE_NAME"
IMAGE_PLATFORM="$(docker image inspect "$IMAGE_NAME" --format '{{.Os}}/{{.Architecture}}')"
[ "$IMAGE_PLATFORM" = "linux/amd64" ] || fail "Image platform is $IMAGE_PLATFORM, expected linux/amd64."
IMAGE_ID="$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')"

docker run --rm --platform linux/amd64 --entrypoint sh "$IMAGE_NAME" -c '
  set -eu
  [ "$(node -p "process.platform + \"/\" + process.arch")" = "linux/x64" ]
  java -version
  test -d /app/.next
  test -f /app/prisma/schema.prisma
  test -f /app/prisma/pre-schema-migrations/20260804_unique_project_members.sql
  test -f /app/prisma/pre-schema-migrations/20260806_approval_workflow_compat.sql
  test -f /app/prisma/manual-migrations/20260803_module_history_snapshots.sql
  test -f /app/prisma/manual-migrations/20260804_role_reference_integrity.sql
  test -f /app/prisma/manual-migrations/20260804_multi_relation_links.sql
  test -f /app/prisma/manual-migrations/20260804_gantt_owner_inheritance_v2.sql
  test -f /app/prisma/manual-migrations/20260804_project_restore_batches.sql
  test -f /app/prisma/manual-migrations/20260804_system_event_logs.sql
  test -f /app/prisma/manual-migrations/20260804_unique_project_members.sql
  test -f /app/prisma/manual-migrations/20260804_wbs_resource_scheduling.sql
  test -f /app/prisma/manual-migrations/20260805_wbs_resource_optimization.sql
  test -f /app/prisma/manual-migrations/20260807_gantt_auto_manual_scheduling.sql
  test -f /app/prisma/manual-migrations/20260810_wbs_baseline_constraint_schedule.sql
  test -f /opt/ceastar/mpp-converter.jar
  pg_dump --version | grep "PostgreSQL) 16\."
  pg_restore --version | grep "PostgreSQL) 16\."
  test -f /app/.next/server/app/api/admin/system-data/backups/route.js
  test -f /app/.next/server/app/api/admin/system-data/backups/project-restore/preview/route.js
  test -f /app/.next/server/app/api/admin/system-data/logs/route.js
  test -f /app/.next/server/app/api/health/ready/route.js
'

printf '\n[4/6] Exporting and hashing the offline image...\n'
mkdir -p "$IMAGE_DIR"
docker save --output "$IMAGE_FILE" "$IMAGE_NAME"
IMAGE_SHA256="$(shasum -a 256 "$IMAGE_FILE" | awk '{print $1}')"
printf '%s\n' "$IMAGE_SHA256" > "$PACKAGE_DIR/image.sha256"

PACKAGE_FILES="
backup.ps1
image-name.txt
release-id.txt
update.bat
update.ps1
rollback.bat
rollback.ps1
repair-mpp-export-service.bat
install-mpp-export-service.ps1
mpp-export-service.ps1
assistant-services.bat
assistant-services.ps1
assistant-service-watchdog.ps1
assistant-service-bridge.ps1
install-assistant-service-bridge.ps1
drawio-mcp.ps1
drawio-mcp-config.json
install-drawio-mcp.ps1
"

for relative_file in $PACKAGE_FILES; do
  [ -f "$SCRIPT_DIR/$relative_file" ] || fail "Required package file is missing: $relative_file"
  cp "$SCRIPT_DIR/$relative_file" "$PACKAGE_DIR/$relative_file"
done

[ -f "$SCRIPT_DIR/更新手册.txt" ] || fail "Required package file is missing: 更新手册.txt"
[ -f "$SCRIPT_DIR/数据库迁移说明.txt" ] || fail "Required package file is missing: 数据库迁移说明.txt"
[ -f "$SCRIPT_DIR/数据安全说明.txt" ] || fail "Required package file is missing: 数据安全说明.txt"
cp "$SCRIPT_DIR/更新手册.txt" "$PACKAGE_DIR/Windows-Update-Guide-CN.txt"
cp "$SCRIPT_DIR/数据库迁移说明.txt" "$PACKAGE_DIR/Database-Migration-Guide-CN.txt"
cp "$SCRIPT_DIR/数据安全说明.txt" "$PACKAGE_DIR/Data-Security-Guide-CN.txt"
cp "$SCRIPT_DIR/智能助手服务说明.txt" "$PACKAGE_DIR/Assistant-Services-Guide-CN.txt"
[ -f "$SCRIPT_DIR/Draw.io-MCP-使用说明.txt" ] || fail "Required package file is missing: Draw.io-MCP-使用说明.txt"
cp "$SCRIPT_DIR/Draw.io-MCP-使用说明.txt" "$PACKAGE_DIR/Draw.io-MCP-Guide-CN.txt"

SOURCE_BRANCH="$(git -C "$REPO_DIR" branch --show-current)"
SOURCE_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)"
if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
  SOURCE_STATE="dirty (the image contains the current working tree)"
else
  SOURCE_STATE="clean"
fi
BUILD_TIME_UTC="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

{
  printf 'Release ID: %s\n' "$RELEASE_ID"
  printf 'Compatible base release: %s (cumulative update; no intermediate package required)\n' "$COMPATIBLE_BASE_RELEASE"
  printf 'Package: %s\n' "$PACKAGE_NAME"
  printf 'Strategy: staged blue-green candidate preflight, health-gated cutover, automatic application rollback\n'
  printf 'Target: Windows 10/11 x86-64 with Docker Desktop Linux containers\n'
  printf 'Docker image: %s\n' "$IMAGE_NAME"
  printf 'Docker image ID: %s\n' "$IMAGE_ID"
  printf 'Docker image platform: %s\n' "$IMAGE_PLATFORM"
  printf 'Image tar SHA256: %s\n' "$IMAGE_SHA256"
  printf 'Git branch: %s\n' "$SOURCE_BRANCH"
  printf 'Git commit: %s\n' "$SOURCE_COMMIT"
  printf 'Working tree: %s\n' "$SOURCE_STATE"
  printf 'Built at UTC: %s\n' "$BUILD_TIME_UTC"
  printf 'Database policy: Expand-compatible migrations; application rollback does not reverse database migrations\n'
  printf 'Validated: tests, lint, typecheck, production build, git diff check, linux/amd64 runtime contents\n'
} > "$PACKAGE_DIR/release-manifest.txt"

printf '\n[5/6] Normalizing Windows line endings and creating ZIP...\n'
for windows_file in "$PACKAGE_DIR"/*.ps1 "$PACKAGE_DIR"/*.bat "$PACKAGE_DIR"/*.txt "$PACKAGE_DIR"/*.sha256; do
  [ -f "$windows_file" ] || continue
  perl -pi -e 's/\r?\n/\r\n/g' "$windows_file"
done

# Windows PowerShell 5.1 treats UTF-8 files without a BOM as the system ANSI
# code page. Chinese text can then corrupt nearby quotes/backticks while the
# script is parsed. Keep every packaged PowerShell script explicitly UTF-8 BOM.
for powershell_file in "$PACKAGE_DIR"/*.ps1; do
  [ -f "$powershell_file" ] || continue
  perl -0777 -i -pe 's/\A(?:\xEF\xBB\xBF)?/\xEF\xBB\xBF/' "$powershell_file"
  perl -e '
    open my $fh, "<:raw", $ARGV[0] or die "cannot read $ARGV[0]: $!";
    read($fh, my $bom, 3) == 3 or exit 1;
    exit($bom eq "\xEF\xBB\xBF" ? 0 : 1);
  ' "$powershell_file" || fail "PowerShell script is missing the UTF-8 BOM: $powershell_file"
done

TAR_COUNT="$(find "$IMAGE_DIR" -maxdepth 1 -type f -name '*.tar' | wc -l | tr -d ' ')"
[ "$TAR_COUNT" = "1" ] || fail "The package must contain exactly one Docker image tar."

(
  cd "$TEMP_ROOT"
  COPYFILE_DISABLE=1 zip -rq -X "$ZIP_FILE" "$PACKAGE_NAME"
)
unzip -tq "$ZIP_FILE" >/dev/null

FORBIDDEN_LISTING="$(unzip -Z1 "$ZIP_FILE" | grep -E '(^|/)(__MACOSX|\.DS_Store|\.env|backups|database\.dump|project-documents\.tar\.gz)($|/)' || true)"
[ -z "$FORBIDDEN_LISTING" ] || fail "Forbidden data was found in the ZIP: $FORBIDDEN_LISTING"

printf '\n[6/6] Finalizing release checksum...\n'
ZIP_SHA256="$(shasum -a 256 "$ZIP_FILE" | awk '{print $1}')"
mv "$ZIP_FILE" "$FINAL_ZIP"
printf '%s  %s\n' "$ZIP_SHA256" "$PACKAGE_NAME.zip" > "$FINAL_ZIP_HASH"

printf '\nWindows update package created successfully.\n'
printf 'CEASTAR_WINDOWS_UPDATE_ZIP=%s\n' "$FINAL_ZIP"
printf 'CEASTAR_WINDOWS_UPDATE_ZIP_SHA256=%s\n' "$ZIP_SHA256"
printf 'CEASTAR_WINDOWS_UPDATE_IMAGE_SHA256=%s\n' "$IMAGE_SHA256"
