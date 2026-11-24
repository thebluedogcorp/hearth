#!/usr/bin/env bash
# Fetches the Windows vendor binaries needed to build Hearth's installer.
# Everything downloaded here is excluded from git (see .gitignore).
#   ffmpeg.exe / ffprobe.exe — gyan.dev FFmpeg essentials build (GPLv3)
#   cloudflared.exe          — Cloudflare Tunnel client
#   HearthService.exe        — WinSW service wrapper (used by install-service.ps1)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FFMPEG_URL="https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
WINSW_URL="https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"

command -v curl >/dev/null || { echo "curl is required"; exit 1; }
command -v unzip >/dev/null || { echo "unzip is required"; exit 1; }

echo "==> Downloading FFmpeg (essentials build)…"
curl -fL --retry 3 -o "$TMP/ffmpeg.zip" "$FFMPEG_URL"
unzip -q -j "$TMP/ffmpeg.zip" "*/bin/ffmpeg.exe" -d "$ROOT/resources/ffmpeg"
unzip -q -j "$TMP/ffmpeg.zip" "*/bin/ffprobe.exe" -d "$ROOT/resources/ffmpeg"
echo "    ffmpeg.exe $(du -h "$ROOT/resources/ffmpeg/ffmpeg.exe" | cut -f1), ffprobe.exe $(du -h "$ROOT/resources/ffmpeg/ffprobe.exe" | cut -f1)"

echo "==> Downloading cloudflared…"
curl -fL --retry 3 -o "$ROOT/resources/binaries/cloudflared.exe" "$CLOUDFLARED_URL"
echo "    cloudflared.exe $(du -h "$ROOT/resources/binaries/cloudflared.exe" | cut -f1)"

echo "==> Downloading WinSW service wrapper…"
curl -fL --retry 3 -o "$ROOT/resources/service/HearthService.exe" "$WINSW_URL"
echo "    HearthService.exe $(du -h "$ROOT/resources/service/HearthService.exe" | cut -f1)"

echo "==> Done. Binaries are in resources/ and are not committed to git."
