#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ ! -f dist/ui/server.js ]; then
  echo "Building..."
  npm run build
fi

exec node dist/ui/server.js
