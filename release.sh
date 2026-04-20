#!/bin/bash
set -e

# One-shot release: bumps version, builds, publishes to npm + VS Code marketplace.
#
# Usage: ./release.sh [patch|minor|major]   (default: patch)
#
# Tokens are read from ~/.notify-mcp-secrets (a key=value file). Format:
#     NPM_TOKEN=npm_xxxxxxxx
#     VSCE_PAT=xxxxxxxx
# See .secrets.example for the full template.
#
# Override behavior:
#   SKIP_NPM=1   ./release.sh   → only publish extension
#   SKIP_VSCE=1  ./release.sh   → only publish npm
#   NO_BUMP=1    ./release.sh   → skip version bump (publish current version as-is)

NPM_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$NPM_DIR/vscode-extension"
SECRETS_FILE="$HOME/.notify-mcp-secrets"

# ── Load secrets ─────────────────────────────────────────────────────────────
# Tokens persist in ~/.notify-mcp-secrets so you set them once and never type
# them again. If the file doesn't exist, we run the interactive setup helper
# automatically (hidden input, no echo, no shell history).
if [ ! -f "$SECRETS_FILE" ]; then
  echo "==> First run — no $SECRETS_FILE yet."
  echo "    Launching setup (one-time, hidden input)..."
  echo ""
  bash "$NPM_DIR/setup-secrets.sh"
  echo ""
fi

if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$SECRETS_FILE"; set +a
fi

if [ -z "$NPM_TOKEN" ] && [ -z "$SKIP_NPM" ]; then
  echo "ERROR: NPM_TOKEN still not set after loading $SECRETS_FILE."
  echo "  Edit the file directly, or re-run: bash setup-secrets.sh"
  exit 1
fi

# VSCE_PAT is optional — vsce login MeniHillel caches the credential, so
# `vsce publish` works without --pat once you've logged in.

cd "$NPM_DIR"

# ── Version bump ─────────────────────────────────────────────────────────────
if [ -n "$NO_BUMP" ]; then
  NEW_VERSION=$(node -p "require('./package.json').version")
  echo "==> NO_BUMP set — using current version $NEW_VERSION"
else
  BUMP=${1:-patch}
  echo "==> Bumping version ($BUMP)..."
  NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
  echo "    Version: $NEW_VERSION"
fi

# ── Build ────────────────────────────────────────────────────────────────────
echo "==> Building MCP server + UI..."
npm run build

# ── npm publish ──────────────────────────────────────────────────────────────
if [ -z "$SKIP_NPM" ]; then
  echo "==> Publishing to npm..."
  npm publish --access public
  echo "    OK npm: omni-notify-mcp@$NEW_VERSION"
else
  echo "==> SKIP_NPM set — skipping npm publish"
fi

# ── VS Code extension publish ────────────────────────────────────────────────
if [ -z "$SKIP_VSCE" ] && [ -d "$EXT_DIR" ]; then
  echo "==> Syncing extension version to $NEW_VERSION..."
  cd "$EXT_DIR"
  node -e "
    const fs=require('fs');
    const p=JSON.parse(fs.readFileSync('package.json','utf8'));
    p.version='$NEW_VERSION';
    fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
  "
  rm -f *.vsix

  echo "==> Publishing extension to VS Code marketplace..."
  if [ -n "$VSCE_PAT" ]; then
    # Explicit PAT in env — use it
    vsce publish --pat "$VSCE_PAT"
  else
    # Use vsce's stored credential (set via `vsce login MeniHillel`)
    vsce publish
  fi
  echo "    OK marketplace: MeniHillel.omni-notify-mcp@$NEW_VERSION"
  cd "$NPM_DIR"
elif [ -n "$SKIP_VSCE" ]; then
  echo "==> SKIP_VSCE set — skipping marketplace publish"
fi

echo ""
echo "Done! Released v$NEW_VERSION"
echo "  npm:         https://www.npmjs.com/package/omni-notify-mcp"
echo "  marketplace: https://marketplace.visualstudio.com/items?itemName=MeniHillel.omni-notify-mcp"
