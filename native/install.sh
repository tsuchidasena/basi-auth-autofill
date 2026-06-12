#!/usr/bin/env bash
# Build + install the native messaging host for Chrome.
# Usage: ./install.sh <EXTENSION_ID>
#   <EXTENSION_ID> is shown on chrome://extensions for this extension.
set -euo pipefail

cd "$(dirname "$0")"

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  echo "ERROR: extension id required."
  echo "Usage: ./install.sh <EXTENSION_ID>"
  echo "  (chrome://extensions に表示される ID をコピーして渡してください)"
  exit 1
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
