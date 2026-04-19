#!/bin/bash
set -e

# Usage: ./release.sh [patch|minor|major]   (default: patch)

NPM_DIR="$(cd "$(dirname "$0")" && pwd)"
BUMP=${1:-patch}

cd "$NPM_DIR"

echo "==> Bumping version ($BUMP)..."
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
echo "    Version: $NEW_VERSION"

echo "==> Building MCP server..."
npm run build:mcp

echo "==> Building UI server..."
npm run build:ui

echo "==> Publishing to npm..."
npm publish --access public
echo "    OK npm: omni-notify-mcp@$NEW_VERSION"

echo ""
echo "Done! Released omni-notify-mcp@$NEW_VERSION to npm."
echo "https://www.npmjs.com/package/omni-notify-mcp"
