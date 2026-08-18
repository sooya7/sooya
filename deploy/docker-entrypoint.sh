#!/usr/bin/env sh
# =============================================================================
# SOOYA container entrypoint.
#
# Docker creates missing bind-mount sources on the host as root:root. The image
# runs as an unprivileged user, so on a first `docker compose up` the app would
# otherwise die with an obscure EACCES while opening the database.
#
# This script checks both mounts up front and, when they are not writable,
# explains exactly how to fix it instead of crash-looping.
# =============================================================================
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
CONFIG_DIR="${CONFIG_DIR:-/app/config}"
CURRENT_UID="$(id -u)"
CURRENT_GID="$(id -g)"

fail() {
  echo "=============================================================" >&2
  echo "SOOYA cannot start: $1" >&2
  echo "" >&2
  echo "The container runs as UID:GID ${CURRENT_UID}:${CURRENT_GID}, but the" >&2
  echo "mounted directory is not writable by that user." >&2
  echo "" >&2
  echo "Fix it on the host with either of:" >&2
  echo "  1) Take ownership of the bind mounts:" >&2
  echo "       sudo chown -R ${CURRENT_UID}:${CURRENT_GID} ./data ./config" >&2
  echo "" >&2
  echo "  2) Run the container as your own user (docker-compose.yml already" >&2
  echo "     reads these from .env):" >&2
  echo "       echo \"SOOYA_UID=\$(id -u)\" >> .env" >&2
  echo "       echo \"SOOYA_GID=\$(id -g)\" >> .env" >&2
  echo "       docker compose up -d" >&2
  echo "=============================================================" >&2
  exit 1
}

ensure_writable() {
  target="$1"
  label="$2"

  # Create it when the mount point exists but the subdirectory does not.
  if [ ! -d "$target" ]; then
    mkdir -p "$target" 2>/dev/null || fail "${label} (${target}) does not exist and cannot be created."
  fi

  probe="${target}/.write-probe.$$"
  if ! (touch "$probe" 2>/dev/null); then
    fail "${label} (${target}) is not writable."
  fi
  rm -f "$probe" 2>/dev/null || true
}

ensure_writable "$DATA_DIR" "DATA_DIR"
ensure_writable "$CONFIG_DIR" "CONFIG_DIR"

# Pre-create the tree the application expects so the first run never races.
for sub in database media media/images media/audio media/stickers media/files media/tmp sticker-source references backups logs; do
  mkdir -p "${DATA_DIR}/${sub}" 2>/dev/null || true
done

# The database and media may contain private conversations.
chmod 700 "$DATA_DIR" 2>/dev/null || true

exec "$@"
