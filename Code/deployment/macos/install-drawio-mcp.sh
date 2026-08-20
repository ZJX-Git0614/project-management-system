#!/usr/bin/env bash
set -euo pipefail

source_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
verify_package=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      [[ $# -ge 2 ]] || { printf '%s\n' "--source requires a directory." >&2; exit 2; }
      source_directory="$2"
      shift 2
      ;;
    --verify)
      verify_package=1
      shift
      ;;
    --help|-h)
      printf '%s\n' "Usage: install-drawio-mcp.sh [--source DIRECTORY] [--verify]"
      exit 0
      ;;
    *)
      printf '%s\n' "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

resolve_npx() {
  local candidate
  if command -v npx >/dev/null 2>&1; then
    command -v npx
    return 0
  fi
  for candidate in /opt/homebrew/bin/npx /usr/local/bin/npx /usr/bin/npx "$HOME"/.nvm/versions/node/*/bin/npx; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

npx_command="$(resolve_npx)" || {
  printf '%s\n' "未找到 npx。请先安装 Node.js LTS，再运行本脚本。" >&2
  exit 127
}

runtime_directory="${CEASTAR_PMS_SUPPORT_DIR:-$HOME/Library/Application Support/Ceastar-PMS}"
mkdir -p "$runtime_directory"

for file_name in drawio-mcp.sh drawio-mcp-config.json; do
  source_path="$source_directory/$file_name"
  [[ -f "$source_path" ]] || { printf '%s\n' "缺少 Draw.io MCP 文件：$source_path" >&2; exit 1; }
  cp "$source_path" "$runtime_directory/$file_name"
done

chmod 0755 "$runtime_directory/drawio-mcp.sh"
chmod 0644 "$runtime_directory/drawio-mcp-config.json"
printf 'NPX_COMMAND=%q\n' "$npx_command" > "$runtime_directory/drawio-mcp.env"
chmod 0600 "$runtime_directory/drawio-mcp.env"

if [[ $verify_package -eq 1 ]]; then
  "$runtime_directory/drawio-mcp.sh" --install
fi

printf '%s\n' "Draw.io MCP 已安装到：$runtime_directory"
printf '%s\n' "请将 drawio-mcp-config.json 中的 drawio 配置合并到所使用的 MCP 客户端。"
