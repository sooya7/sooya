#!/usr/bin/env bash
# =============================================================================
# SOOYA — restore from a backup archive produced by backup.sh.
#
# The archive and embedded database are verified before the service is stopped.
# The pre-restore state is preserved and automatically restored if the restored
# service cannot pass its readiness check.
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

SHARED_DIR="$BASE_DIR/shared"
DATA_DIR="$SHARED_DIR/data"
[[ -d "$SHARED_DIR" ]] || die "$SHARED_DIR not found"
SERVICE_USER="$(stat -c '%U' "$SHARED_DIR" 2>/dev/null || echo sooya)"
PORT="$(grep -E '^PORT=' "$SHARED_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8788}"

find_better_sqlite3() {
  local candidate
  for candidate in "$BASE_DIR/current" "$BASE_DIR/releases"/*; do
    if [[ -d "$candidate/node_modules/better-sqlite3" ]]; then
      printf '%s\n' "$candidate/node_modules/better-sqlite3"
      return 0
    fi
    if [[ -d "$candidate/packages/server/node_modules/better-sqlite3" ]]; then
      printf '%s\n' "$candidate/packages/server/node_modules/better-sqlite3"
      return 0
    fi
  done
  return 1
}

verify_database() {
  local db="$1"
  local check module
  if command -v sqlite3 >/dev/null 2>&1; then
    check="$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 || echo failed)"
    [[ "$check" == "ok" ]] || die "backup database failed integrity_check: $check"
    return 0
  fi

  module="$(find_better_sqlite3 || true)"
  [[ -n "$module" && -x "$(command -v node || true)" ]] || \
    die "cannot verify backup database: install sqlite3 or keep a working SOOYA runtime"
  node -e '
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
    const rows = db.pragma("integrity_check");
    db.close();
    const ok = Array.isArray(rows) && rows.length > 0 && rows.every((row) => Object.values(row)[0] === "ok");
    if (!ok) { console.error(JSON.stringify(rows)); process.exit(1); }
  ' "$module" "$db" || die "backup database failed integrity_check"
}

wait_for_health() {
  local attempts="${1:-40}"
  local _
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "http://127.0.0.1:${PORT}/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Verify the checksum when it is present.
if [[ -f "$ARCHIVE.sha256" ]]; then
  log "verifying checksum"
  ( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" ) || die "checksum mismatch"
fi

tar -tzf "$ARCHIVE" >/dev/null 2>&1 || die "archive is not readable"
while IFS= read -r entry; do
  normalized="${entry#./}"
  [[ "$normalized" != /* && "$normalized" != ../* && "$normalized" != *'/../'* ]] || \
    die "archive contains an unsafe path: $entry"
done < <(tar -tzf "$ARCHIVE")

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar --no-same-owner --no-same-permissions -C "$STAGE" -xzf "$ARCHIVE"
[[ -z "$(find "$STAGE" -type l -print -quit)" ]] || die "archive contains symbolic links"

if [[ -f "$STAGE/database/sooya.db" ]]; then
  log "checking backup database integrity before stopping SOOYA"
  verify_database "$STAGE/database/sooya.db"
  log "backup database passed integrity_check"
fi

log "stopping SOOYA"
systemctl stop sooya 2>/dev/null || warn "service was not running"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SAFETY="$DATA_DIR/pre-restore-$STAMP"
mkdir -p "$SAFETY"
[[ -d "$DATA_DIR/database" ]] && cp -a "$DATA_DIR/database" "$SAFETY/database"
[[ -d "$DATA_DIR/media" ]] && cp -a "$DATA_DIR/media" "$SAFETY/media"
[[ -d "$SHARED_DIR/config" ]] && cp -a "$SHARED_DIR/config" "$SAFETY/config"
log "previous state preserved in $SAFETY"

rollback_previous_state() {
  warn "restored state is unhealthy — restoring the pre-restore state"
  systemctl stop sooya 2>/dev/null || true

  rm -rf "$DATA_DIR/database" "$DATA_DIR/media" "$SHARED_DIR/config"
  [[ -d "$SAFETY/database" ]] && cp -a "$SAFETY/database" "$DATA_DIR/database"
  [[ -d "$SAFETY/media" ]] && cp -a "$SAFETY/media" "$DATA_DIR/media"
  [[ -d "$SAFETY/config" ]] && cp -a "$SAFETY/config" "$SHARED_DIR/config"
  mkdir -p "$DATA_DIR" "$SHARED_DIR/config"
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$SHARED_DIR"

  systemctl start sooya 2>/dev/null || true
  if wait_for_health 30; then
    warn "automatic rollback succeeded; the previous state is active"
  else
    warn "automatic rollback completed on disk but the previous service is also unhealthy"
  fi
}

if [[ -f "$STAGE/database/sooya.db" ]]; then
  log "restoring the database"
  rm -rf "$DATA_DIR/database"
  mkdir -p "$DATA_DIR/database"
  cp -p "$STAGE/database/sooya.db" "$DATA_DIR/database/sooya.db"
fi

if [[ -d "$STAGE/media" ]]; then
  log "restoring media"
  rm -rf "$DATA_DIR/media"
  cp -a "$STAGE/media" "$DATA_DIR/media"
fi

if [[ -d "$STAGE/config" ]]; then
  log "restoring configuration (persona / models)"
  rm -rf "$SHARED_DIR/config"
  mkdir -p "$SHARED_DIR/config"
  cp -a "$STAGE/config/." "$SHARED_DIR/config/"
fi

chown -R "$SERVICE_USER":"$SERVICE_USER" "$SHARED_DIR"

log "starting SOOYA"
systemctl start sooya 2>/dev/null || warn "could not start the service automatically"

if wait_for_health 40; then
  log "restore complete; SOOYA is healthy"
  exit 0
fi

rollback_previous_state
die "restore failed its health check and was rolled back; attempted state remains in $SAFETY"
