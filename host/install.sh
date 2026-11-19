#!/usr/bin/env bash
# Registers the native messaging host (com.jprats.argo_submit) with Chrome for the current user (macOS / Linux).
# The extension ID is fixed by the "key" in extension/manifest.json, so this works for the unpacked extension too.
set -euo pipefail

NAME=com.jprats.argo_submit
EXT_ID=ajiiibcolikndfnfjedienfpmjblmfkm
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="$DIR/argo_sso_host.py"
chmod 755 "$HOST"

case "$(uname -s)" in
  Darwin) BASE="$HOME/Library/Application Support" ; DIRS=("Google/Chrome" "Google/Chrome Beta" "Chromium") ;;
  *)      BASE="$HOME/.config" ; DIRS=("google-chrome" "google-chrome-beta" "chromium") ;;
esac

for d in "${DIRS[@]}"; do
  [[ -d "$BASE/$d" ]] || continue
  mkdir -p "$BASE/$d/NativeMessagingHosts"
  cat > "$BASE/$d/NativeMessagingHosts/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Writes the Argo SSO token to ~/.cache/argo-sso",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "installed: $BASE/$d/NativeMessagingHosts/$NAME.json"
done
