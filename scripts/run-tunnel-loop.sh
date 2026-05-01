#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-3737}"

while true; do
  echo "[tunnel] starting localtunnel on port $PORT"
  npx -y localtunnel --port "$PORT" || true
  echo "[tunnel] localtunnel exited; restarting in 2s"
  sleep 2
done
