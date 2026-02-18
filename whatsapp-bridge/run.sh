#!/usr/bin/env bash
set -e

echo "[Bridge] Starting WhatsApp Bridge..."

# Ensure persistent session directory exists
mkdir -p /data/wwebjs_auth

# Detect the Chromium binary – path varies across Alpine versions
if command -v chromium-browser &>/dev/null; then
  export PUPPETEER_EXECUTABLE_PATH=$(command -v chromium-browser)
elif command -v chromium &>/dev/null; then
  export PUPPETEER_EXECUTABLE_PATH=$(command -v chromium)
else
  echo "[Bridge] WARNING: Chromium binary not found in PATH!"
fi

export PUPPETEER_SKIP_DOWNLOAD=true
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

echo "[Bridge] Chromium: ${PUPPETEER_EXECUTABLE_PATH}"

cd /app || exit 1
exec node server.js
