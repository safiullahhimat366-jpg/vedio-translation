#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "============================================================"
echo "  SadaVox Studio - Independent Desktop Window Launcher"
echo "============================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js 20+ is required for first-time setup."
  echo "Install Node.js LTS from https://nodejs.org/ and run this script again."
  exit 1
fi

if [ ! -d "node_modules/express" ]; then
  echo "[1/3] Installing SadaVox Studio runtime packages..."
  npm install --legacy-peer-deps --no-audit --no-fund
fi

if [ ! -d "node_modules/electron" ]; then
  echo "[2/3] Downloading standalone Electron Desktop Engine + FFmpeg binaries..."
  npm install --no-save --legacy-peer-deps --no-audit --no-fund electron ffmpeg-static ffprobe-static
fi

if [ ! -f "dist-desktop/server.cjs" ]; then
  echo "[3/3] Compiling Desktop Studio Bundle..."
  npm run desktop:build
fi

echo "Launching SadaVox Studio as an independent desktop window..."
./node_modules/.bin/electron electron/main.mjs
