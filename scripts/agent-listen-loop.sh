#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${NOTIFY_BASE_URL:-http://localhost:3737}"
API_KEY="${NOTIFY_AGENT_KEY:-}"
TAG="${NOTIFY_TAG:-}"
TIMEOUT_SECONDS="${NOTIFY_WAIT_TIMEOUT_SECONDS:-50}"
ON_MESSAGE_CMD="${NOTIFY_ON_MESSAGE_CMD:-}"
RETRY_DELAY_SECONDS="${NOTIFY_RETRY_DELAY_SECONDS:-2}"

build_url() {
  local url="$BASE_URL/api/agent/inbox/wait?timeout_seconds=$TIMEOUT_SECONDS"
  if [[ -n "$TAG" ]]; then
    url="$url&tag=$TAG"
  fi
  printf "%s" "$url"
}

while true; do
  URL="$(build_url)"
  if ! RESP="$(curl -sS "$URL" ${API_KEY:+-H "x-notify-key: $API_KEY"})"; then
    >&2 printf "[agent-listen-loop] wait request failed, retrying in %ss\n" "$RETRY_DELAY_SECONDS"
    sleep "$RETRY_DELAY_SECONDS"
    continue
  fi

  if [[ "$RESP" == *'"empty":true'* ]]; then
    continue
  fi

  printf "%s\n" "$RESP"

  if [[ -n "$ON_MESSAGE_CMD" ]]; then
    export NOTIFY_LAST_INBOX_JSON="$RESP"
    bash -lc "$ON_MESSAGE_CMD" || true
  fi
done
