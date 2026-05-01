#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${NOTIFY_BASE_URL:-http://localhost:3737}"
API_KEY="${NOTIFY_AGENT_KEY:-}"
TAG="${1:-}"

URL="$BASE_URL/api/agent/inbox/poll"
if [[ -n "$TAG" ]]; then
  URL="$URL?tag=$TAG"
fi

curl -sS "$URL" \
  ${API_KEY:+-H "x-notify-key: $API_KEY"} | cat
