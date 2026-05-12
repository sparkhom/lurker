#!/usr/bin/env bash
# One-shot migration: rename data files and reminders for the caint → lurker rebrand.
# Run from the repo root. Stops the docker stack, renames the sqlite triplet,
# patches DATABASE_PATH and WEBAUTHN_RP_NAME in .env, and starts the stack back up.
#
# Safe to re-run: skips files that are already renamed.

set -euo pipefail

cd "$(dirname "$0")/.."

DATA_DIR="data"
ENV_FILE=".env"

if [ -f "$DATA_DIR/caint.db" ] && [ ! -f "$DATA_DIR/lurker.db" ]; then
  echo "Stopping docker stack (if running)..."
  docker compose down 2>/dev/null || true

  echo "Renaming sqlite files..."
  mv "$DATA_DIR/caint.db" "$DATA_DIR/lurker.db"
  [ -f "$DATA_DIR/caint.db-shm" ] && mv "$DATA_DIR/caint.db-shm" "$DATA_DIR/lurker.db-shm"
  [ -f "$DATA_DIR/caint.db-wal" ] && mv "$DATA_DIR/caint.db-wal" "$DATA_DIR/lurker.db-wal"
else
  echo "DB files already migrated or no caint.db present — skipping rename."
fi

if [ -f "$ENV_FILE" ]; then
  echo "Patching $ENV_FILE..."
  # macOS/BSD and GNU sed both accept -i with a backup suffix; use empty suffix.
  sed -i.bak \
    -e 's|DATABASE_PATH=\./data/caint\.db|DATABASE_PATH=./data/lurker.db|' \
    -e 's|DATABASE_PATH=/app/data/caint\.db|DATABASE_PATH=/app/data/lurker.db|' \
    -e 's|^WEBAUTHN_RP_NAME=Caint$|WEBAUTHN_RP_NAME=Lurker|' \
    "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
else
  echo "No $ENV_FILE found — skipping env patch."
fi

echo
echo "Done. Bring the stack back up with:"
echo "  docker compose up -d"
echo
echo "Note: existing session cookies (caint_session) are now stale — you'll"
echo "be prompted to sign in again on first load. Passkey still works."
