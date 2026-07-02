#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.local-runtime"
mkdir -p "$LOG_DIR"

DEV_PORT=3001
PROD_PORT=3000
DEV_PID_FILE="$LOG_DIR/dev.pid"
PROD_PID_FILE="$LOG_DIR/prod.pid"
DEV_LOG_FILE="$LOG_DIR/dev.log"
PROD_LOG_FILE="$LOG_DIR/prod.log"

usage() {
  cat <<'EOF'
用法：
  ./scripts/local-env.sh start dev      启动开发环境
  ./scripts/local-env.sh start prod     启动生产环境
  ./scripts/local-env.sh start all      同时启动开发+生产环境
  ./scripts/local-env.sh stop dev       停止开发环境
  ./scripts/local-env.sh stop prod      停止生产环境
  ./scripts/local-env.sh stop all       停止全部环境
  ./scripts/local-env.sh restart dev    重启开发环境
  ./scripts/local-env.sh restart prod   重启生产环境
  ./scripts/local-env.sh restart all    重启全部环境
  ./scripts/local-env.sh status         查看当前状态
EOF
}

is_running_pid() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

cleanup_pid_file_if_stale() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if ! is_running_pid "$pid"; then
      rm -f "$pid_file"
    fi
  fi
}

kill_port_if_needed() {
  local port="$1"
  local pids
  pids="$(lsof -ti tcp:"$port" || true)"
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill >/dev/null 2>&1 || true
    sleep 1
  fi
}

start_dev() {
  cleanup_pid_file_if_stale "$DEV_PID_FILE"
  if [[ -f "$DEV_PID_FILE" ]] && is_running_pid "$(cat "$DEV_PID_FILE")"; then
    echo "开发环境已在运行: http://localhost:$DEV_PORT (PID $(cat "$DEV_PID_FILE"))"
    return
  fi

  kill_port_if_needed "$DEV_PORT"
  echo "启动开发环境 http://localhost:$DEV_PORT"
  (
    cd "$ROOT_DIR"
    PORT="$DEV_PORT" nohup npm run dev:local >"$DEV_LOG_FILE" 2>&1 &
    echo $! >"$DEV_PID_FILE"
  )
  sleep 3
  echo "开发环境已启动，日志: $DEV_LOG_FILE"
}

start_prod() {
  cleanup_pid_file_if_stale "$PROD_PID_FILE"
  if [[ -f "$PROD_PID_FILE" ]] && is_running_pid "$(cat "$PROD_PID_FILE")"; then
    echo "生产环境已在运行: http://localhost:$PROD_PORT (PID $(cat "$PROD_PID_FILE"))"
    return
  fi

  kill_port_if_needed "$PROD_PORT"
  echo "构建生产环境..."
  (
    cd "$ROOT_DIR"
    npm run build
  )
  echo "启动生产环境 http://localhost:$PROD_PORT"
  (
    cd "$ROOT_DIR"
    PORT="$PROD_PORT" nohup npm run start:local >"$PROD_LOG_FILE" 2>&1 &
    echo $! >"$PROD_PID_FILE"
  )
  sleep 2
  echo "生产环境已启动，日志: $PROD_LOG_FILE"
}

stop_one() {
  local name="$1"
  local pid_file="$2"
  local port="$3"

  cleanup_pid_file_if_stale "$pid_file"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if is_running_pid "$pid"; then
      kill "$pid" >/dev/null 2>&1 || true
      sleep 1
      if is_running_pid "$pid"; then
        kill -9 "$pid" >/dev/null 2>&1 || true
      fi
    fi
    rm -f "$pid_file"
  fi

  kill_port_if_needed "$port"
  echo "$name 已停止"
}

status_one() {
  local name="$1"
  local pid_file="$2"
  local port="$3"
  local url="$4"

  cleanup_pid_file_if_stale "$pid_file"
  if [[ -f "$pid_file" ]] && is_running_pid "$(cat "$pid_file")"; then
    echo "$name: RUNNING | $url | PID $(cat "$pid_file")"
  else
    local port_pid
    port_pid="$(lsof -ti tcp:"$port" || true)"
    if [[ -n "$port_pid" ]]; then
      echo "$name: RUNNING(未登记PID文件) | $url | PID $port_pid"
    else
      echo "$name: STOPPED | $url"
    fi
  fi
}

action="${1:-}"
target="${2:-}"

case "$action" in
  start)
    case "$target" in
      dev) start_dev ;;
      prod) start_prod ;;
      all) start_prod; start_dev ;;
      *) usage; exit 1 ;;
    esac
    ;;
  stop)
    case "$target" in
      dev) stop_one "开发环境" "$DEV_PID_FILE" "$DEV_PORT" ;;
      prod) stop_one "生产环境" "$PROD_PID_FILE" "$PROD_PORT" ;;
      all)
        stop_one "开发环境" "$DEV_PID_FILE" "$DEV_PORT"
        stop_one "生产环境" "$PROD_PID_FILE" "$PROD_PORT"
        ;;
      *) usage; exit 1 ;;
    esac
    ;;
  restart)
    case "$target" in
      dev)
        stop_one "开发环境" "$DEV_PID_FILE" "$DEV_PORT"
        start_dev
        ;;
      prod)
        stop_one "生产环境" "$PROD_PID_FILE" "$PROD_PORT"
        start_prod
        ;;
      all)
        stop_one "开发环境" "$DEV_PID_FILE" "$DEV_PORT"
        stop_one "生产环境" "$PROD_PID_FILE" "$PROD_PORT"
        start_prod
        start_dev
        ;;
      *) usage; exit 1 ;;
    esac
    ;;
  status)
    status_one "开发环境" "$DEV_PID_FILE" "$DEV_PORT" "http://localhost:$DEV_PORT"
    status_one "生产环境" "$PROD_PID_FILE" "$PROD_PORT" "http://localhost:$PROD_PORT"
    ;;
  *)
    usage
    exit 1
    ;;
esac
