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
  # Copy the LICENSE into the extension dir so the .vsix includes it (vsce
  # warns when missing). Done before vsce reads package.json.
  cp -f "$NPM_DIR/LICENSE" "$EXT_DIR/LICENSE" 2>/dev/null || true

  cd "$EXT_DIR"
  # Bump extension package.json version to match. Use a tempfile to avoid
  # the bash/Git-Bash quoting confusion that broke the previous heredoc.
  NEW_VER="$NEW_VERSION" node <<'EOF'
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = process.env.NEW_VER;
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
EOF
  rm -f *.vsix

  echo "==> Publishing extension to VS Code marketplace..."
  # `--no-update-package-json` keeps vsce from auto-bumping again on top of
  # our explicit version. `--skip-license` not used — we ship a real LICENSE.
  if [ -n "$VSCE_PAT" ]; then
    vsce publish --pat "$VSCE_PAT" --no-update-package-json "$NEW_VERSION"
  else
    vsce publish --no-update-package-json "$NEW_VERSION"
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
