#!/usr/bin/env bash
# =============================================================================
# SOOYA — backup script (database + media + configuration).
#
# Produces one timestamped tar.gz plus a SHA256 file, and verifies the archive
# before applying the retention policy. Safe to run from cron while SOOYA is
# running: the database is copied with the SQLite backup API through the admin
# endpoint when available, otherwise with a WAL-safe file copy.
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
  # A plain `cp` of sooya.db plus its -wal/-shm sidecars is NOT consistent: the
  # three files are copied at different instants, so a checkpoint landing in
  # between yields a main file and a WAL that disagree, and the restored
  # database can be missing committed rows or fail integrity_check.
  #
  # Use SQLite's own snapshot mechanism instead, which serialises against
  # writers and folds the WAL into a single self-contained file.
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
    # No sqlite3 CLI: fall back to the better-sqlite3 backup API that ships
    # with the application itself.
    for candidate in "$BASE_DIR/current" "$BASE_DIR/releases"/*; do
      [[ -d "$candidate/node_modules/better-sqlite3" || -d "$candidate/packages/server/node_modules/better-sqlite3" ]] || continue
      log "snapshotting the database with better-sqlite3 (backup API)"
      if (cd "$candidate" && node -e '
        const Database = require("better-sqlite3");
        const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
        db.backup(process.argv[2]).then(() => { db.close(); }).catch((e) => {
          console.error(e.message); process.exit(1);
        });
      ' "$DB" "$STAGE/database/sooya.db" 2>/dev/null); then
        SNAPSHOT_OK=1
      fi
      break
    done
  fi

  if [[ "$SNAPSHOT_OK" -ne 1 ]]; then
    # Last resort. Checkpoint the WAL first so the main file is self-contained,
    # and copy the sidecars too so nothing committed is dropped.
    warn "no SQLite snapshot tool available; falling back to a checkpointed file copy"
    command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
    for suffix in "" "-wal" "-shm"; do
      [[ -f "${DB}${suffix}" ]] && cp -p "${DB}${suffix}" "$STAGE/database/sooya.db${suffix}"
    done
  fi
fi

# Verify the snapshot before it is archived, so a corrupt backup is never kept.
if [[ -f "$STAGE/database/sooya.db" ]] && command -v sqlite3 >/dev/null 2>&1; then
  CHECK="$(sqlite3 "$STAGE/database/sooya.db" 'PRAGMA integrity_check;' 2>&1 || echo failed)"
  if [[ "$CHECK" != "ok" ]]; then
    die "snapshot failed integrity_check: $CHECK"
  fi
  log "snapshot passed integrity_check"
fi
[[ -f "$STAGE/database/sooya.db" ]] || warn "no database found — backing up files only"

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

# Verify the embedded database if sqlite3 is available.
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$STAGE/database/sooya.db" ]]; then
  RESULT="$(sqlite3 "$STAGE/database/sooya.db" 'PRAGMA integrity_check;' 2>&1 || echo failed)"
  [[ "$RESULT" == "ok" ]] || warn "database integrity_check returned: $RESULT"
fi

log "verified: $(du -h "$ARCHIVE" | cut -f1) $ARCHIVE"

# -------------------------------- 5. retention -------------------------------
mapfile -t OLD < <(ls -1t "$OUT_DIR"/sooya-backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)
for f in "${OLD[@]:-}"; do
  [[ -z "$f" ]] && continue
  log "pruning $f"
  rm -f "$f" "$f.sha256"
done

log "backup complete"
