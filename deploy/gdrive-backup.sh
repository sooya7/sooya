#!/usr/bin/env bash
# SOOYA Google Drive backup uploader.
# Creates a WAL-safe SOOYA archive first, then uploads the archive + checksum
# with rclone. The live SQLite database is never placed on Google Drive.
set -Eeuo pipefail

BASE_DIR="/opt/sooya"
ENV_FILE=""
FORCE=0

log()  { printf '\033[0;36m[gdrive-backup]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[gdrive-backup]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[gdrive-backup]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BASE_DIR="$2"; shift 2 ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--dir /opt/sooya] [--env /path/gdrive-backup.env] [--force]"
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

ENV_FILE="${ENV_FILE:-$BASE_DIR/shared/gdrive-backup.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

ENABLED="${GDRIVE_BACKUP_ENABLED:-false}"
if [[ "$FORCE" -ne 1 && "$ENABLED" != "true" && "$ENABLED" != "1" ]]; then
  log "disabled; set GDRIVE_BACKUP_ENABLED=true to enable"
  exit 0
fi

command -v rclone >/dev/null 2>&1 || die "rclone is required"

REMOTE_NAME="${GDRIVE_RCLONE_REMOTE:-gdrive}"
REMOTE_NAME="${REMOTE_NAME%:}"
REMOTE_PATH="${GDRIVE_BACKUP_PATH:-SOOYA/backups}"
REMOTE_PATH="${REMOTE_PATH#/}"
REMOTE_PATH="${REMOTE_PATH%/}"
RCLONE_CONFIG="${GDRIVE_RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}"
LOCAL_KEEP="${GDRIVE_LOCAL_KEEP:-14}"
REMOTE_KEEP="${GDRIVE_REMOTE_KEEP:-30}"
LOCAL_DIR="${GDRIVE_LOCAL_DIR:-$BASE_DIR/shared/data/backups/cloud}"

[[ "$LOCAL_KEEP" =~ ^[1-9][0-9]*$ ]] || die "GDRIVE_LOCAL_KEEP must be >= 1"
[[ "$REMOTE_KEEP" =~ ^[1-9][0-9]*$ ]] || die "GDRIVE_REMOTE_KEEP must be >= 1"
[[ -n "$REMOTE_NAME" ]] || die "GDRIVE_RCLONE_REMOTE is empty"
[[ -n "$REMOTE_PATH" ]] || die "GDRIVE_BACKUP_PATH is empty"
[[ -f "$RCLONE_CONFIG" ]] || die "rclone config not found: $RCLONE_CONFIG"

RCLONE=(rclone --config "$RCLONE_CONFIG")
"${RCLONE[@]}" listremotes | grep -Fxq "$REMOTE_NAME:" || die "rclone remote '$REMOTE_NAME' is not configured"

BACKUP_SCRIPT="$BASE_DIR/current/deploy/backup.sh"
[[ -x "$BACKUP_SCRIPT" ]] || die "backup script not executable: $BACKUP_SCRIPT"
mkdir -p "$LOCAL_DIR"

log "creating verified local backup"
"$BACKUP_SCRIPT" --dir "$BASE_DIR" --out "$LOCAL_DIR" --keep "$LOCAL_KEEP"

ARCHIVE="$(ls -1t "$LOCAL_DIR"/sooya-backup-*.tar.gz 2>/dev/null | head -1 || true)"
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || die "backup script did not produce an archive"
[[ -f "$ARCHIVE.sha256" ]] || die "backup checksum missing: $ARCHIVE.sha256"
( cd "$LOCAL_DIR" && sha256sum -c "$(basename "$ARCHIVE").sha256" ) >/dev/null || die "local checksum verification failed"

REMOTE_ROOT="$REMOTE_NAME:$REMOTE_PATH"
BASE="$(basename "$ARCHIVE")"
log "uploading $BASE to $REMOTE_ROOT"
"${RCLONE[@]}" mkdir "$REMOTE_ROOT"
"${RCLONE[@]}" copyto "$ARCHIVE" "$REMOTE_ROOT/$BASE" --retries 3 --low-level-retries 10
"${RCLONE[@]}" copyto "$ARCHIVE.sha256" "$REMOTE_ROOT/$BASE.sha256" --retries 3 --low-level-retries 10

log "verifying uploaded files"
"${RCLONE[@]}" check "$LOCAL_DIR" "$REMOTE_ROOT" \
  --one-way \
  --include "$BASE" \
  --include "$BASE.sha256" \
  --checkers 2 >/dev/null || die "remote verification failed"

mapfile -t OLD < <(
  "${RCLONE[@]}" lsf "$REMOTE_ROOT" --files-only --include 'sooya-backup-*.tar.gz' 2>/dev/null \
    | sort -r \
    | tail -n +$((REMOTE_KEEP + 1))
)
for old in "${OLD[@]:-}"; do
  [[ -z "$old" ]] && continue
  log "pruning remote backup $old"
  "${RCLONE[@]}" deletefile "$REMOTE_ROOT/$old"
  "${RCLONE[@]}" deletefile "$REMOTE_ROOT/$old.sha256" 2>/dev/null || true
done

log "Google Drive backup complete: $REMOTE_ROOT/$BASE"
