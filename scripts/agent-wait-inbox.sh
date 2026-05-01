#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${NOTIFY_BASE_URL:-http://localhost:3737}"
API_KEY="${NOTIFY_AGENT_KEY:-}"
TAG="${1:-}"
TIMEOUT_SECONDS="${2:-50}"

URL="$BASE_URL/api/agent/inbox/wait?timeout_seconds=$TIMEOUT_SECONDS"
if [[ -n "$TAG" ]]; then
  URL="$URL&tag=$TAG"
fi

curl -sS "$URL" \
  ${API_KEY:+-H "x-notify-key: $API_KEY"} | cat
