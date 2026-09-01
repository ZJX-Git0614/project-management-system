#!/usr/bin/env bash
set -euo pipefail

drawio_mcp_package="${CEASTAR_DRAWIO_MCP_PACKAGE:-@drawio/mcp@1.5.0}"
runtime_directory="${CEASTAR_PMS_SUPPORT_DIR:-$HOME/Library/Application Support/Ceastar-PMS}"
runtime_environment="$runtime_directory/drawio-mcp.env"

show_help() {
  printf '%s\n' "Ceastar PMS Draw.io MCP launcher"
  printf '%s\n' "Usage: drawio-mcp.sh [--install|--help]"
  printf '%s\n' "  --install  Download and verify $drawio_mcp_package."
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  show_help
  exit 0
fi

if [[ -f "$runtime_environment" ]]; then
  # The installer records an absolute npx path because macOS GUI clients do
  # not inherit the PATH configured by an interactive shell.
  # shellcheck disable=SC1090
  source "$runtime_environment"
fi

resolve_npx() {
  local candidate
  if [[ -n "${NPX_COMMAND:-}" && -x "$NPX_COMMAND" ]]; then
    printf '%s\n' "$NPX_COMMAND"
    return 0
  fi

  for candidate in /opt/homebrew/bin/npx /usr/local/bin/npx /usr/bin/npx; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v npx >/dev/null 2>&1; then
    command -v npx
    return 0
  fi

  for candidate in "$HOME"/.nvm/versions/node/*/bin/npx; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

npx_command="$(resolve_npx)" || {
  printf '%s\n' "Draw.io MCP could not find npx. Install Node.js LTS and rerun install-drawio-mcp.sh." >&2
  exit 127
}

if [[ "${1:-}" == "--install" ]]; then
  printf '%s\n' "Downloading and verifying $drawio_mcp_package..."
  "$npx_command" -y "$drawio_mcp_package" --help
  printf '%s\n' "Draw.io MCP is ready."
  exit 0
fi

exec "$npx_command" -y "$drawio_mcp_package"
