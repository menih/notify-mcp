#!/bin/bash
set -e

NPM_DIR="$(cd "$(dirname "$0")" && pwd)"
VSCODE_DIR="$HOME/Desktop/vscode-omni-notify"
BUMP=${1:-patch}  # usage: ./release.sh [patch|minor|major]

echo "==> Bumping version ($BUMP)..."
cd "$NPM_DIR"
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
echo "    Version: $NEW_VERSION"

echo "==> Building MCP server..."
npm run build:mcp

echo "==> Building UI server..."
npm run build:ui

echo "==> Publishing to npm..."
npm publish --access public
echo "    ✓ npm: omni-notify-mcp@$NEW_VERSION"

echo "==> Bumping VS Code extension version..."
cd "$VSCODE_DIR"
# update version in package.json to match
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "==> Packaging VS Code extension..."
vsce package
VSIX="$VSCODE_DIR/omni-notify-mcp-$NEW_VERSION.vsix"
echo "    ✓ vsix: $VSIX"

echo "==> Opening marketplace for manual upload..."
open "https://marketplace.visualstudio.com/manage/publishers/menihillel"
echo "    Upload: $VSIX"

echo ""
echo "Done! npm@$NEW_VERSION published. Upload the .vsix on the marketplace page."
