#!/usr/bin/env bash
# Build + install the native messaging host for Chrome.
# Usage: ./install.sh [EXTENSION_ID]
#   The ID is derived from extension/manifest.json's "key" when omitted, so
#   nobody has to copy a 32-character string out of chrome://extensions to set
#   this up. Pass one explicitly to override.
set -euo pipefail

cd "$(dirname "$0")"

MANIFEST="../extension/manifest.json"

# Chrome derives the ID from the manifest key: SHA-256 the DER public key, take
# the first 16 bytes, map each nibble 0-f onto a-p. Everything below is in the
# macOS base install — no Node, no Python, nothing to install first.
derive_id() {
  local key
  key=$(sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" 2>/dev/null)
  [[ -z "$key" ]] && return 1
  printf '%s' "$key" | base64 -d 2>/dev/null | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p'
}

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  EXT_ID=$(derive_id || true)
  if [[ -z "$EXT_ID" ]]; then
    echo "ERROR: could not derive the extension id from $MANIFEST."
    echo "  Pass it explicitly: ./install.sh <EXTENSION_ID>"
    echo "  （chrome://extensions に表示される ID をコピーして渡してください）"
    exit 1
  fi
  echo "==> Derived extension id from $MANIFEST: $EXT_ID"
fi

HOST_NAME="com.tsuchida.basic_auth_autofill"
BINARY_PATH="$(pwd)/bin/basic-auth-touchid"

# 1. Build
./build.sh

# 2. Write host manifest into Chrome's NativeMessagingHosts dir
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$TARGET_DIR"
TARGET="$TARGET_DIR/$HOST_NAME.json"

sed -e "s#__BINARY_PATH__#$BINARY_PATH#" \
    -e "s#__EXTENSION_ID__#$EXT_ID#" \
    host-manifest.template.json > "$TARGET"

echo "==> Installed native host manifest:"
echo "    $TARGET"
echo "==> Binary: $BINARY_PATH"
echo "==> allowed_origins: chrome-extension://$EXT_ID/"
echo ""
echo "Chrome を再起動（または拡張を再読み込み）してから検証ページを試してください。"
