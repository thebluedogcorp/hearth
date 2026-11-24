#!/usr/bin/env bash
# Builds the Hearth Windows NSIS installer on Linux WITHOUT wine.
#
# electron-builder's own NSIS target must run the installer under wine once to
# produce the uninstaller, so on Linux we do it in two proven steps instead:
#   1. npx electron-builder --dir  → dist/win-unpacked (packaged app, no installer)
#   2. native makensis (from electron-builder's cache) + scripts/installer-linux.nsh
# Windows CI/CD (release workflow) uses the standard electron-builder path instead.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

VERSION=$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')
MAKENSIS=$(ls "$HOME"/.cache/electron-builder/nsis-3.0.4.1/*/linux/makensis 2>/dev/null | head -1)
if [ -z "$MAKENSIS" ]; then
  echo "makensis not found in electron-builder cache — run an electron-builder NSIS build once (it downloads it)"; exit 1
fi

echo "==> Packaging app (electron-builder --dir)…"
npx electron-builder --dir --win --x64

echo "==> Compiling installer with native makensis $MAKENSIS…"
"$MAKENSIS" \
  -DAPPVERSION="$VERSION" \
  -DAPPSOURCE="$(pwd)/dist/win-unpacked" \
  -DOUTFILE="$(pwd)/dist/Hearth-Setup-$VERSION-x64.exe" \
  scripts/installer-linux.nsh

echo "==> Done: dist/Hearth-Setup-$VERSION-x64.exe"
ls -la "dist/Hearth-Setup-$VERSION-x64.exe"
