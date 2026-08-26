#!/usr/bin/env bash
# Download a SOOYA backup from Google Drive and hand it to restore-backup.sh.
set -Eeuo pipefail

BASE_DIR="/opt/sooya"
ENV_FILE=""
NAME=""
LIST=0

log()  { printf '\033[0;36m[gdrive-restore]\033[0m %s\n' "$*"; }
die()  { printf '\033[0;31m[gdrive-restore]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BASE_DIR="$2"; shift 2 ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --latest) NAME=""; shift ;;
    --list) LIST=1; shift ;;
    -h|--help)
      echo "Usage: sudo $0 [--latest | --name sooya-backup-...tar.gz | --list] [--dir /opt/sooya]"
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "please run as root (sudo)"
ENV_FILE="${ENV_FILE:-$BASE_DIR/shared/gdrive-backup.env}"
[[ -f "$ENV_FILE" ]] || die "config not found: $ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

command -v rclone >/dev/null 2>&1 || die "rclone is required"
REMOTE_NAME="${GDRIVE_RCLONE_REMOTE:-gdrive}"
REMOTE_NAME="${REMOTE_NAME%:}"
REMOTE_PATH="${GDRIVE_BACKUP_PATH:-SOOYA/backups}"
REMOTE_PATH="${REMOTE_PATH#/}"
REMOTE_PATH="${REMOTE_PATH%/}"
RCLONE_CONFIG="${GDRIVE_RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}"
[[ -f "$RCLONE_CONFIG" ]] || die "rclone config not found: $RCLONE_CONFIG"
RCLONE=(rclone --config "$RCLONE_CONFIG")
REMOTE_ROOT="$REMOTE_NAME:$REMOTE_PATH"

if [[ "$LIST" -eq 1 ]]; then
  "${RCLONE[@]}" lsf "$REMOTE_ROOT" --files-only --include 'sooya-backup-*.tar.gz' | sort -r
  exit 0
fi

if [[ -z "$NAME" ]]; then
  NAME="$("${RCLONE[@]}" lsf "$REMOTE_ROOT" --files-only --include 'sooya-backup-*.tar.gz' | sort -r | head -1)"
fi
[[ "$NAME" =~ ^sooya-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] || die "invalid or missing backup name: $NAME"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ARCHIVE="$STAGE/$NAME"

log "downloading $REMOTE_ROOT/$NAME"
"${RCLONE[@]}" copyto "$REMOTE_ROOT/$NAME" "$ARCHIVE" --retries 3 --low-level-retries 10
"${RCLONE[@]}" copyto "$REMOTE_ROOT/$NAME.sha256" "$ARCHIVE.sha256" --retries 3 --low-level-retries 10
( cd "$STAGE" && sha256sum -c "$NAME.sha256" ) >/dev/null || die "downloaded backup failed checksum verification"

RESTORE_SCRIPT="$BASE_DIR/current/deploy/restore-backup.sh"
[[ -x "$RESTORE_SCRIPT" ]] || die "restore script not executable: $RESTORE_SCRIPT"
log "checksum verified; starting SOOYA restore"
exec "$RESTORE_SCRIPT" --file "$ARCHIVE" --dir "$BASE_DIR"
