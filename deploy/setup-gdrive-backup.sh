#!/usr/bin/env bash
# Configure SOOYA's Google Drive backup timer on a native /opt/sooya install.
set -Eeuo pipefail

BASE_DIR="/opt/sooya"
REMOTE_NAME="gdrive"
REMOTE_PATH="SOOYA/backups"
REMOTE_KEEP="30"
LOCAL_KEEP="14"
RUN_NOW=1

log()  { printf '\033[0;36m[gdrive-setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[gdrive-setup]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[gdrive-setup]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BASE_DIR="$2"; shift 2 ;;
    --remote) REMOTE_NAME="${2%:}"; shift 2 ;;
    --path) REMOTE_PATH="$2"; shift 2 ;;
    --remote-keep) REMOTE_KEEP="$2"; shift 2 ;;
    --local-keep) LOCAL_KEEP="$2"; shift 2 ;;
    --no-run) RUN_NOW=0; shift ;;
    -h|--help)
      echo "Usage: sudo $0 [--dir /opt/sooya] [--remote gdrive] [--path SOOYA/backups] [--no-run]"
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "please run as root (sudo)"
[[ "$REMOTE_KEEP" =~ ^[1-9][0-9]*$ ]] || die "--remote-keep must be >= 1"
[[ "$LOCAL_KEEP" =~ ^[1-9][0-9]*$ ]] || die "--local-keep must be >= 1"
[[ -d "$BASE_DIR/current/deploy" ]] || die "$BASE_DIR/current/deploy not found"

if ! command -v rclone >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    log "installing rclone"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y rclone
  else
    die "rclone is required; install it first"
  fi
fi

RCLONE_CONFIG="/root/.config/rclone/rclone.conf"
mkdir -p "$(dirname "$RCLONE_CONFIG")"
chmod 700 "$(dirname "$RCLONE_CONFIG")"

if ! rclone --config "$RCLONE_CONFIG" listremotes 2>/dev/null | grep -Fxq "$REMOTE_NAME:"; then
  warn "rclone remote '$REMOTE_NAME' is not configured yet"
  echo
  echo "Create a Google Drive remote named '$REMOTE_NAME'. When rclone asks for the storage type, choose 'drive'."
  echo
  rclone --config "$RCLONE_CONFIG" config
fi

rclone --config "$RCLONE_CONFIG" listremotes | grep -Fxq "$REMOTE_NAME:" || \
  die "remote '$REMOTE_NAME' still does not exist"

ENV_FILE="$BASE_DIR/shared/gdrive-backup.env"
mkdir -p "$BASE_DIR/shared"
cat > "$ENV_FILE" <<EOF
GDRIVE_BACKUP_ENABLED=true
GDRIVE_RCLONE_REMOTE=$REMOTE_NAME
GDRIVE_BACKUP_PATH=$REMOTE_PATH
GDRIVE_RCLONE_CONFIG=$RCLONE_CONFIG
GDRIVE_LOCAL_KEEP=$LOCAL_KEEP
GDRIVE_REMOTE_KEEP=$REMOTE_KEEP
EOF
chmod 600 "$ENV_FILE"

log "checking Google Drive access"
rclone --config "$RCLONE_CONFIG" mkdir "$REMOTE_NAME:$REMOTE_PATH"
rclone --config "$RCLONE_CONFIG" lsf "$REMOTE_NAME:$REMOTE_PATH" --max-depth 1 >/dev/null

log "installing systemd units"
sed "s|/opt/sooya|$BASE_DIR|g" \
  "$BASE_DIR/current/deploy/sooya-gdrive-backup.service" \
  > /etc/systemd/system/sooya-gdrive-backup.service
cp "$BASE_DIR/current/deploy/sooya-gdrive-backup.timer" \
  /etc/systemd/system/sooya-gdrive-backup.timer
systemctl daemon-reload
systemctl enable --now sooya-gdrive-backup.timer

if [[ "$RUN_NOW" -eq 1 ]]; then
  log "running the first verified backup now"
  systemctl start sooya-gdrive-backup.service
  systemctl --no-pager --full status sooya-gdrive-backup.service || true
fi

log "configured: every 6 hours -> $REMOTE_NAME:$REMOTE_PATH"
log "restore latest: sudo $BASE_DIR/current/deploy/gdrive-restore.sh --latest --dir $BASE_DIR"
