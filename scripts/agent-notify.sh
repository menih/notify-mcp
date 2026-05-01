#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${NOTIFY_BASE_URL:-http://localhost:3737}"
API_KEY="${NOTIFY_AGENT_KEY:-}"
MESSAGE="${1:-}"
PRIORITY="${2:-normal}"

if [[ -z "$MESSAGE" ]]; then
  echo "usage: scripts/agent-notify.sh \"message\" [low|normal|high]" >&2
  exit 1
fi

curl -sS -X POST "$BASE_URL/api/agent/notify" \
  -H "Content-Type: application/json" \
  ${API_KEY:+-H "x-notify-key: $API_KEY"} \
  -d "{\"message\":\"${MESSAGE//\"/\\\"}\",\"priority\":\"$PRIORITY\"}" | cat
