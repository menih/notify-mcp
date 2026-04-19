#!/bin/bash
set -e

# Usage: ./release.sh [patch|minor|major]   (default: patch)
#
# Publishes both:
#   1. The npm package (omni-notify-mcp) — needs `npm login` + 2FA OTP
#   2. The VS Code extension (MeniHillel.omni-notify-mcp) — needs VSCE_PAT
#      env var with marketplace > Manage scope
#
# Either half can be skipped:
#   SKIP_NPM=1   ./release.sh   → only publish extension
#   SKIP_VSCE=1  ./release.sh   → only publish npm

NPM_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$NPM_DIR/vscode-extension"
BUMP=${1:-patch}

cd "$NPM_DIR"

echo "==> Bumping version ($BUMP)..."
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
echo "    Version: $NEW_VERSION"

echo "==> Building MCP server..."
npm run build:mcp

echo "==> Building UI server..."
npm run build:ui

# ── npm publish ──────────────────────────────────────────────────────────────
if [ -z "$SKIP_NPM" ]; then
  echo "==> Publishing to npm..."
  if [ -n "$NPM_OTP" ]; then
    npm publish --access public --otp="$NPM_OTP"
  else
    npm publish --access public
  fi
  echo "    OK npm: omni-notify-mcp@$NEW_VERSION"
else
  echo "==> SKIP_NPM set — skipping npm publish"
fi

# ── VS Code extension publish ────────────────────────────────────────────────
if [ -z "$SKIP_VSCE" ]; then
  if [ ! -d "$EXT_DIR" ]; then
    echo "==> No vscode-extension/ folder — skipping marketplace publish"
  else
    echo "==> Syncing extension version to $NEW_VERSION..."
    cd "$EXT_DIR"
    node -e "
      const fs=require('fs');
      const p=JSON.parse(fs.readFileSync('package.json','utf8'));
      p.version='$NEW_VERSION';
      fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
    "

    if [ -z "$VSCE_PAT" ]; then
      echo "==> VSCE_PAT not set — packaging .vsix only (no marketplace upload)"
      npx --yes @vscode/vsce package
      echo "    .vsix written to $EXT_DIR"
      echo "    Set VSCE_PAT and re-run, or upload manually at:"
      echo "    https://marketplace.visualstudio.com/manage/publishers/menihillel"
    else
      echo "==> Publishing to VS Code marketplace..."
      npx --yes @vscode/vsce publish --pat "$VSCE_PAT"
      echo "    OK marketplace: MeniHillel.omni-notify-mcp@$NEW_VERSION"
    fi
    cd "$NPM_DIR"
  fi
else
  echo "==> SKIP_VSCE set — skipping marketplace publish"
fi

echo ""
echo "Done! Released v$NEW_VERSION"
echo "  npm:         https://www.npmjs.com/package/omni-notify-mcp"
echo "  marketplace: https://marketplace.visualstudio.com/items?itemName=MeniHillel.omni-notify-mcp"
