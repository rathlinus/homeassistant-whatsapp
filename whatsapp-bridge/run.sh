#!/usr/bin/env bash
set -e

echo "[Bridge] Starting WhatsApp Bridge..."

# /data/options.json is written by the HA Supervisor with the user's config.
# server.js reads it directly, so no extra parsing is needed here.
# We just ensure the persistent data directory exists.
mkdir -p /data/wwebjs_auth

cd /app || exit 1
exec node server.js
