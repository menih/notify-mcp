#!/bin/bash
# Smart guided setup for release secrets. Detects which tokens are already
# valid and skips them — so you only get prompted for what's actually broken
# or missing.
#
# Run anytime: bash ./setup-secrets.sh
#   - First time:   prompts for both tokens
#   - Token expired: detects and prompts for just that one
#   - Both valid:   says "all good" and exits
#
# Tokens read with hidden input (no echo, no shell history). Saved to
# ~/.notify-mcp-secrets with chmod 600.

set -e

SECRETS_FILE="$HOME/.notify-mcp-secrets"

open_url() {
  local url="$1"
  if command -v start >/dev/null 2>&1; then
    start "" "$url" 2>/dev/null || true
  elif command -v open >/dev/null 2>&1; then
    open "$url" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" 2>/dev/null || true
  fi
}

hr() { echo "--------------------------------------------------------------------------------"; }

# ── Load existing secrets if present ─────────────────────────────────────────
EXISTING_NPM=""
EXISTING_VSCE=""
if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$SECRETS_FILE"; set +a
  EXISTING_NPM="${NPM_TOKEN:-}"
  EXISTING_VSCE="${VSCE_PAT:-}"
fi

# ── Validators ───────────────────────────────────────────────────────────────
# Returns 0 if the npm token can publish, 1 otherwise.
validate_npm() {
  local token="$1"
  [ -z "$token" ] && return 1
  # `npm whoami` with the token in env — uses ~/.npmrc which references ${NPM_TOKEN}
  NPM_TOKEN="$token" npm whoami --registry=https://registry.npmjs.org/ >/dev/null 2>&1
}

# Returns 0 if vsce can publish (either via PAT in arg or via cached login).
# If a token is passed, validates that. If empty, checks the cached credential.
validate_vsce() {
  local token="$1"
  if [ -n "$token" ]; then
    vsce verify-pat MeniHillel --pat "$token" >/dev/null 2>&1
  else
    # No token — check if vsce login is cached and works
    vsce verify-pat MeniHillel >/dev/null 2>&1
  fi
}

# ── Detect what needs attention ──────────────────────────────────────────────
clear || true
echo ""
hr
echo "  omni-notify-mcp — release auth check"
hr
echo ""

NPM_OK=0
VSCE_OK=0

echo -n "  Checking npm token... "
if validate_npm "$EXISTING_NPM"; then
  echo "✓ valid"
  NPM_OK=1
else
  if [ -n "$EXISTING_NPM" ]; then
    echo "✗ INVALID (revoked, expired, or wrong scope)"
  else
    echo "✗ not set"
  fi
fi

echo -n "  Checking marketplace credential... "
if validate_vsce "$EXISTING_VSCE"; then
  echo "✓ valid"
  VSCE_OK=1
else
  if [ -n "$EXISTING_VSCE" ]; then
    echo "✗ PAT INVALID — and no cached vsce login either"
  else
    echo "✗ no PAT and no cached vsce login"
  fi
fi

echo ""

# ── If everything's already good, exit ───────────────────────────────────────
if [ $NPM_OK -eq 1 ] && [ $VSCE_OK -eq 1 ]; then
  hr
  echo "  ✓ All credentials valid — nothing to do."
  hr
  echo ""
  echo "  Ship: bash ./release.sh"
  echo ""
  exit 0
fi

hr
echo "  Will prompt only for what's missing/broken."
hr
read -rp "  Press Enter to continue..." _

# ── npm token (if needed) ────────────────────────────────────────────────────
NEW_NPM=""
if [ $NPM_OK -eq 0 ]; then
  clear || true
  echo ""
  hr
  echo "  npm token"
  hr
  echo ""
  echo "  URL (opening in your browser):"
  echo "    https://www.npmjs.com/settings/karish911/tokens"
  echo ""
  echo "  Steps:"
  echo "    1. Click 'Generate New Token' (top-right)"
  echo "    2. Pick 'Granular Access Token'"
  echo "    3. Token name: omni-notify-publish"
  echo "    4. Expiration: 90 days (their max)"
  echo "    5. Bypass 2FA: ✅ check it"
  echo "    6. Permissions: Read and write"
  echo "    7. Packages and scopes: pick 'All packages'  ← critical"
  echo "       (scoping to a specific package often causes 404s)"
  echo "    8. Generate token → copy (starts with npm_...)"
  echo ""
  open_url "https://www.npmjs.com/settings/karish911/tokens"
  echo ""

  # Loop until we get a valid one (or user gives up with Ctrl-C)
  while :; do
    read -rsp "  Paste npm token (input hidden, Enter to skip): " NEW_NPM
    echo ""
    if [ -z "$NEW_NPM" ]; then
      echo "  ⊘ Skipped npm token — release will fail until fixed."
      break
    fi
    echo -n "  Validating... "
    if validate_npm "$NEW_NPM"; then
      echo "✓ works"
      break
    else
      echo "✗ rejected by registry. Check scope/permissions and try again."
      echo "    (Or press Enter on empty to skip.)"
    fi
  done
fi

# ── Marketplace PAT (if needed) ──────────────────────────────────────────────
NEW_VSCE=""
SKIP_VSCE_SAVE=0
if [ $VSCE_OK -eq 0 ]; then
  clear || true
  echo ""
  hr
  echo "  VS Code Marketplace credential"
  hr
  echo ""
  echo "  Two ways to authenticate vsce:"
  echo "    A. Cache login locally (no token in our file):"
  echo "         vsce login MeniHillel"
  echo "       Recommended — token stays in OS keychain."
  echo ""
  echo "    B. Paste a PAT here and we'll save it to the secrets file."
  echo ""
  echo "  Either way, get a PAT first:"
  echo "    URL (opening): https://dev.azure.com/"
  echo "    Avatar → Personal access tokens → New Token"
  echo "    Org: All accessible orgs · Expiration: 1 year"
  echo "    Scopes: Custom defined → Marketplace → Manage"
  echo ""
  open_url "https://dev.azure.com/"
  echo ""
  read -rsp "  Paste marketplace PAT (input hidden, Enter to skip): " NEW_VSCE
  echo ""
  if [ -z "$NEW_VSCE" ]; then
    echo "  ⊘ Skipped — make sure 'vsce login MeniHillel' is set up separately."
    SKIP_VSCE_SAVE=1
  else
    echo -n "  Validating... "
    if validate_vsce "$NEW_VSCE"; then
      echo "✓ works"
    else
      echo "✗ rejected by marketplace. Check scope (must be Marketplace > Manage)."
      SKIP_VSCE_SAVE=1
    fi
  fi
fi

# ── Write the file ───────────────────────────────────────────────────────────
# Preserve existing valid tokens; only overwrite what we got new.
FINAL_NPM="${NEW_NPM:-$EXISTING_NPM}"
FINAL_VSCE=""
if [ $SKIP_VSCE_SAVE -eq 0 ] && [ -n "$NEW_VSCE" ]; then
  FINAL_VSCE="$NEW_VSCE"
elif [ $VSCE_OK -eq 1 ]; then
  FINAL_VSCE="$EXISTING_VSCE"
fi

{
  echo "# Generated by setup-secrets.sh on $(date)"
  echo "# Re-run anytime to refresh — only invalid tokens get re-prompted."
  echo ""
  if [ -n "$FINAL_NPM" ]; then
    echo "NPM_TOKEN=$FINAL_NPM"
  fi
  if [ -n "$FINAL_VSCE" ]; then
    echo "VSCE_PAT=$FINAL_VSCE"
  fi
} > "$SECRETS_FILE"

chmod 600 "$SECRETS_FILE"

clear || true
echo ""
hr
echo "  ✓ DONE — wrote $SECRETS_FILE (chmod 600)"
hr
echo ""
[ -n "$FINAL_NPM" ]  && echo "  npm:         saved + validated"  || echo "  npm:         (not set — release will fail)"
[ -n "$FINAL_VSCE" ] && echo "  marketplace: PAT saved + validated"
[ -z "$FINAL_VSCE" ] && [ $VSCE_OK -eq 0 ] && echo "  marketplace: relying on 'vsce login MeniHillel' (verify it's set up)"
echo ""
echo "  Now ship: bash ./release.sh"
echo ""
