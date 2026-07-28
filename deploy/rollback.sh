#!/usr/bin/env bash
# =============================================================================
# SOOYA — roll back to a previous release.
#
# Only the code is rolled back. Data, media, database and configuration live in
# $BASE_DIR/shared and are left untouched, so a rollback never loses chat
# history. To also roll back the database, restore a backup afterwards
# (see restore-backup.sh).
#
# Usage: sudo ./deploy/rollback.sh [--dir /opt/sooya] [--to <release-id>] [--list]
# =============================================================================
set -Eeuo pipefail

BASE_DIR="/opt/sooya"
TARGET=""
LIST_ONLY=0

log()  { printf '\033[0;36m[rollback]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[rollback]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[rollback]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BASE_DIR="$2"; shift 2 ;;
    --to) TARGET="$2"; shift 2 ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

RELEASES_DIR="$BASE_DIR/releases"
[[ -d "$RELEASES_DIR" ]] || die "$RELEASES_DIR not found"

CURRENT="$(readlink -f "$BASE_DIR/current" 2>/dev/null || true)"

if [[ "$LIST_ONLY" -eq 1 ]]; then
  echo "available releases (newest first):"
  for dir in $(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null); do
    id="$(basename "$dir")"
    mark=" "
    [[ "$(readlink -f "$dir")" == "$CURRENT" ]] && mark="*"
    printf '  %s %s\n' "$mark" "$id"
  done
  exit 0
fi

[[ $EUID -eq 0 ]] || die "please run as root (sudo)"

if [[ -z "$TARGET" ]]; then
  # Pick the newest release that is not the current one.
  for dir in $(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null); do
    if [[ "$(readlink -f "$dir")" != "$CURRENT" ]]; then
      TARGET="$(basename "$dir")"
      break
    fi
  done
fi

[[ -n "$TARGET" ]] || die "no previous release available to roll back to"
TARGET_DIR="$RELEASES_DIR/$TARGET"
[[ -d "$TARGET_DIR" ]] || die "release $TARGET not found in $RELEASES_DIR"
[[ -f "$TARGET_DIR/packages/server/dist/main.js" ]] || die "release $TARGET is not built (missing dist)"

log "rolling back to $TARGET"
ln -sfn "$TARGET_DIR" "$BASE_DIR/current.new"
mv -Tf "$BASE_DIR/current.new" "$BASE_DIR/current"
echo "$TARGET" > "$BASE_DIR/CURRENT_RELEASE"

systemctl daemon-reload 2>/dev/null || true
systemctl restart sooya 2>/dev/null || warn "could not restart the service automatically"

PORT="$(grep -E '^PORT=' "$BASE_DIR/shared/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8788}"
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health/ready" >/dev/null 2>&1; then
    log "rollback complete; SOOYA is healthy on port $PORT"
    exit 0
  fi
  sleep 1
done
die "rolled back but the service is not healthy; check: journalctl -u sooya -n 200"
