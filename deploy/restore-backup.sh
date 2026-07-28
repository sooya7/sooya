#!/usr/bin/env bash
# =============================================================================
# SOOYA — restore from a backup archive produced by backup.sh.
#
# The service is stopped first so no WAL can be replayed over the restored
# database. The pre-restore state is preserved so a bad restore is recoverable.
#
# Usage: sudo ./deploy/restore-backup.sh --file /path/sooya-backup-*.tar.gz [--dir /opt/sooya]
# =============================================================================
set -Eeuo pipefail

BASE_DIR="/opt/sooya"
ARCHIVE=""

log()  { printf '\033[0;36m[restore]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[restore]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[restore]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) ARCHIVE="$2"; shift 2 ;;
    --dir) BASE_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "please run as root (sudo)"
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || die "--file <archive.tar.gz> is required"

# Verify the checksum when it is present.
if [[ -f "$ARCHIVE.sha256" ]]; then
  log "verifying checksum"
  ( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" ) || die "checksum mismatch"
fi
tar -tzf "$ARCHIVE" >/dev/null 2>&1 || die "archive is not readable"

SHARED_DIR="$BASE_DIR/shared"
DATA_DIR="$SHARED_DIR/data"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -C "$STAGE" -xzf "$ARCHIVE"

log "stopping SOOYA"
systemctl stop sooya 2>/dev/null || warn "service was not running"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SAFETY="$DATA_DIR/pre-restore-$STAMP"
mkdir -p "$SAFETY"
[[ -d "$DATA_DIR/database" ]] && cp -a "$DATA_DIR/database" "$SAFETY/database"
[[ -d "$DATA_DIR/media" ]] && cp -a "$DATA_DIR/media" "$SAFETY/media"
log "previous state preserved in $SAFETY"

if [[ -f "$STAGE/database/sooya.db" ]]; then
  log "restoring the database"
  mkdir -p "$DATA_DIR/database"
  rm -f "$DATA_DIR/database/sooya.db" "$DATA_DIR/database/sooya.db-wal" "$DATA_DIR/database/sooya.db-shm"
  cp -p "$STAGE/database/sooya.db" "$DATA_DIR/database/sooya.db"
  for suffix in "-wal" "-shm"; do
    [[ -f "$STAGE/database/sooya.db${suffix}" ]] && cp -p "$STAGE/database/sooya.db${suffix}" "$DATA_DIR/database/sooya.db${suffix}"
  done
fi

if [[ -d "$STAGE/media" ]]; then
  log "restoring media"
  rm -rf "$DATA_DIR/media"
  cp -a "$STAGE/media" "$DATA_DIR/media"
fi

if [[ -d "$STAGE/config" ]]; then
  log "restoring configuration (persona / models)"
  cp -a "$STAGE/config/." "$SHARED_DIR/config/"
fi

SERVICE_USER="$(stat -c '%U' "$SHARED_DIR" 2>/dev/null || echo sooya)"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$SHARED_DIR"

log "starting SOOYA"
systemctl start sooya 2>/dev/null || warn "could not start the service automatically"

PORT="$(grep -E '^PORT=' "$SHARED_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8788}"
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health/ready" >/dev/null 2>&1; then
    log "restore complete; SOOYA is healthy"
    exit 0
  fi
  sleep 1
done
die "restored but the service is not healthy; the previous state is in $SAFETY"
