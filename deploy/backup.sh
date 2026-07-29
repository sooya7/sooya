#!/usr/bin/env bash
# =============================================================================
# SOOYA — backup script (database + media + configuration).
#
# Produces one timestamped tar.gz plus a SHA256 file, and verifies the archive
# before applying the retention policy. Safe to run from cron while SOOYA is
# running: the database is snapshotted through SQLite's backup mechanism and an
# unsafe raw copy of live WAL files is never accepted as a backup.
#
# Usage: ./deploy/backup.sh [--dir /opt/sooya] [--out /path/to/backups] [--keep 14]
# =============================================================================
set -Eeuo pipefail

BASE_DIR="/opt/sooya"
OUT_DIR=""
KEEP=14

log()  { printf '\033[0;36m[backup]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[backup]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[backup]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BASE_DIR="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

SHARED_DIR="$BASE_DIR/shared"
[[ -d "$SHARED_DIR" ]] || die "$SHARED_DIR not found"
DATA_DIR="$SHARED_DIR/data"
OUT_DIR="${OUT_DIR:-$DATA_DIR/backups}"
mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

PORT="$(grep -E '^PORT=' "$SHARED_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8788}"
ADMIN_TOKEN="$(grep -E '^ADMIN_API_TOKEN=' "$SHARED_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"

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

verify_snapshot() {
  local snapshot="$1"
  local check module
  if command -v sqlite3 >/dev/null 2>&1; then
    check="$(sqlite3 "$snapshot" 'PRAGMA integrity_check;' 2>&1 || echo failed)"
    [[ "$check" == "ok" ]] || die "snapshot failed integrity_check: $check"
    log "snapshot passed integrity_check (sqlite3)"
    return 0
  fi

  module="$(find_better_sqlite3 || true)"
  [[ -n "$module" && -x "$(command -v node || true)" ]] || \
    die "cannot verify database snapshot: install sqlite3 or keep a working SOOYA runtime"
  node -e '
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
    const rows = db.pragma("integrity_check");
    db.close();
    const ok = Array.isArray(rows) && rows.length > 0 && rows.every((row) => Object.values(row)[0] === "ok");
    if (!ok) { console.error(JSON.stringify(rows)); process.exit(1); }
  ' "$module" "$snapshot" || die "snapshot failed integrity_check"
  log "snapshot passed integrity_check (better-sqlite3)"
}

# ------------------------------ 1. the database ------------------------------
mkdir -p "$STAGE/database"
DB="$DATA_DIR/database/sooya.db"
if [[ -n "$ADMIN_TOKEN" ]] && curl -fsS -X POST -H "x-admin-token: $ADMIN_TOKEN" \
     "http://127.0.0.1:${PORT}/api/admin/backups" >/dev/null 2>&1; then
  log "triggered a verified online backup through the admin API"
  # Copy the newest verified snapshot the app produced.
  NEWEST="$(ls -1t "$DATA_DIR"/backups/sooya-*.db 2>/dev/null | head -1 || true)"
  [[ -n "$NEWEST" ]] && cp -p "$NEWEST" "$STAGE/database/sooya.db"
fi

if [[ ! -f "$STAGE/database/sooya.db" && -f "$DB" ]]; then
  # A live SQLite database in WAL mode must be copied by SQLite itself. Copying
  # the database and its journal sidecars separately can mix points in time.
  SNAPSHOT_OK=0

  if command -v sqlite3 >/dev/null 2>&1; then
    log "snapshotting the database with sqlite3 (.backup, WAL-consistent)"
    if sqlite3 "$DB" ".timeout 10000" ".backup '$STAGE/database/sooya.db'" 2>/dev/null; then
      SNAPSHOT_OK=1
    else
      warn "sqlite3 .backup failed; trying VACUUM INTO"
      rm -f "$STAGE/database/sooya.db"
      if sqlite3 "$DB" ".timeout 10000" "VACUUM INTO '$STAGE/database/sooya.db'" 2>/dev/null; then
        SNAPSHOT_OK=1
      fi
    fi
  fi

  if [[ "$SNAPSHOT_OK" -ne 1 ]] && command -v node >/dev/null 2>&1; then
    MODULE="$(find_better_sqlite3 || true)"
    if [[ -n "$MODULE" ]]; then
      log "snapshotting the database with better-sqlite3 (backup API)"
      rm -f "$STAGE/database/sooya.db"
      if node -e '
        const Database = require(process.argv[1]);
        const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
        db.backup(process.argv[3]).then(() => { db.close(); }).catch((e) => {
          console.error(e.message); process.exit(1);
        });
      ' "$MODULE" "$DB" "$STAGE/database/sooya.db" 2>/dev/null; then
        SNAPSHOT_OK=1
      fi
    fi
  fi

  # Historical raw sidecar-copy fallback intentionally removed. It could still
  # combine files from different moments when no SQLite snapshot tool existed.
  [[ "$SNAPSHOT_OK" -eq 1 ]] || \
    die "no WAL-safe SQLite snapshot mechanism is available; refusing an unsafe live-file copy"
fi

if [[ -f "$STAGE/database/sooya.db" ]]; then
  verify_snapshot "$STAGE/database/sooya.db"
elif [[ -f "$DB" ]]; then
  die "database exists but no verified snapshot was produced"
else
  warn "no database found — backing up files only"
fi

# --------------------------- 2. media and configuration ----------------------
[[ -d "$DATA_DIR/media" ]] && cp -a "$DATA_DIR/media" "$STAGE/media"
[[ -d "$SHARED_DIR/config" ]] && cp -a "$SHARED_DIR/config" "$STAGE/config"

# The .env holds API keys; include it only when explicitly requested.
if [[ "${INCLUDE_ENV:-0}" == "1" && -f "$SHARED_DIR/.env" ]]; then
  warn "including .env (contains secrets) because INCLUDE_ENV=1"
  cp -p "$SHARED_DIR/.env" "$STAGE/env.backup"
fi

cat > "$STAGE/manifest.json" <<JSON
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(hostname)",
  "baseDir": "$BASE_DIR",
  "includesEnv": ${INCLUDE_ENV:-0},
  "mediaFiles": $(find "$STAGE" -path "$STAGE/media/*" -type f 2>/dev/null | wc -l)
}
JSON

# --------------------------------- 3. archive --------------------------------
ARCHIVE="$OUT_DIR/sooya-backup-$STAMP.tar.gz"
log "creating $ARCHIVE"
tar -C "$STAGE" -czf "$ARCHIVE.part" .
mv "$ARCHIVE.part" "$ARCHIVE"

# --------------------------------- 4. verify ---------------------------------
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  rm -f "$ARCHIVE"
  die "archive verification failed"
fi
( cd "$OUT_DIR" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256" )
log "verified: $(du -h "$ARCHIVE" | cut -f1) $ARCHIVE"

# -------------------------------- 5. retention -------------------------------
mapfile -t OLD < <(ls -1t "$OUT_DIR"/sooya-backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)
for f in "${OLD[@]:-}"; do
  [[ -z "$f" ]] && continue
  log "pruning $f"
  rm -f "$f" "$f.sha256"
done

log "backup complete"