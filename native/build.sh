#!/usr/bin/env bash
# Build the native messaging host binary and ad-hoc codesign it.
# Requires Xcode command line tools (swiftc).
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p bin

echo "==> Compiling Swift native host..."
swiftc -O \
  -framework LocalAuthentication \
  -framework Security \
  -o bin/basic-auth-touchid \
  src/main.swift

echo "==> Ad-hoc codesigning (required for Keychain biometric access)..."
codesign --force --sign - --timestamp=none bin/basic-auth-touchid

echo "==> Done: $(pwd)/bin/basic-auth-touchid"
codesign -dv bin/basic-auth-touchid 2>&1 | sed 's/^/    /' || true
