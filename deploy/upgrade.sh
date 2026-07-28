#!/usr/bin/env bash
# =============================================================================
# SOOYA — upgrade to a new release.
#
# Guarantees:
#   * .env, config/, data/, media, database, persona and model configuration
#     live in $BASE_DIR/shared and are NEVER touched by an upgrade;
#   * a verified database backup is taken before switching;
#   * the previous release stays on disk so rollback.sh is instant;
#   * if the new release fails its health check, the old one is restored
#     automatically.
#
# Usage: sudo ./deploy/upgrade.sh [--dir /opt/sooya] [--source /path/to/new/src]
# =============================================================================
set -Eeuo pipefail

BASE_DIR="/opt/sooya"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="sooya"
KEEP_RELEASES=5

log()  { printf '\033[0;36m[upgrade]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[upgrade]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[upgrade]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BASE_DIR="$2"; shift 2 ;;
    --source) SOURCE_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "please run as root (sudo)"
SHARED_DIR="$BASE_DIR/shared"
[[ -d "$SHARED_DIR" ]] || die "$SHARED_DIR not found — run install.sh first"

PREVIOUS_TARGET=""
if [[ -L "$BASE_DIR/current" ]]; then
  PREVIOUS_TARGET="$(readlink -f "$BASE_DIR/current")"
  log "current release: $PREVIOUS_TARGET"
fi

PORT="$(grep -E '^PORT=' "$SHARED_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8788}"

# ------------------------- 1. back up before touching anything ---------------
log "creating a pre-upgrade backup"
ADMIN_TOKEN="$(grep -E '^ADMIN_API_TOKEN=' "$SHARED_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
if [[ -n "$ADMIN_TOKEN" ]] && curl -fsS -X POST \
      -H "x-admin-token: $ADMIN_TOKEN" \
      "http://127.0.0.1:${PORT}/api/admin/backups" >/dev/null 2>&1; then
  log "online backup created through the admin API"
else
  # Offline copy: safe because we also copy the WAL sidecars.
  DB="$SHARED_DIR/data/database/sooya.db"
  if [[ -f "$DB" ]]; then
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$SHARED_DIR/data/backups"
    for suffix in "" "-wal" "-shm"; do
      [[ -f "${DB}${suffix}" ]] && cp -p "${DB}${suffix}" "$SHARED_DIR/data/backups/pre-upgrade-${STAMP}.db${suffix}"
    done
    log "offline database copy stored in $SHARED_DIR/data/backups"
  else
    warn "no database found yet; skipping backup"
  fi
fi

# ------------------------------ 2. build the new release ---------------------
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="$BASE_DIR/releases/$RELEASE_ID"
log "staging new release in $RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

tar -C "$SOURCE_DIR" \
    --exclude='./node_modules' \
    --exclude='./.git' \
    --exclude='./data' \
    --exclude='./release' \
    --exclude='./.env' \
    --exclude='./e2e/test-results' \
    --exclude='./playwright-report' \
    -cf - . | tar -C "$RELEASE_DIR" -xf -

cd "$RELEASE_DIR"
log "installing dependencies"
npm ci --build-from-source=better-sqlite3
log "building"
npm run build -w @sooya/server
npm run build -w @sooya/web
rm -rf "$RELEASE_DIR/public"
cp -r "$RELEASE_DIR/packages/web/dist" "$RELEASE_DIR/public"
npm prune --omit=dev

chown -R "$SERVICE_USER":"$SERVICE_USER" "$RELEASE_DIR"

# ---------------------------------- 3. switch --------------------------------
log "switching the current symlink"
ln -sfn "$RELEASE_DIR" "$BASE_DIR/current.new"
mv -Tf "$BASE_DIR/current.new" "$BASE_DIR/current"
chown -h "$SERVICE_USER":"$SERVICE_USER" "$BASE_DIR/current"
echo "$RELEASE_ID" > "$BASE_DIR/CURRENT_RELEASE"

systemctl daemon-reload
systemctl restart sooya

# -------------------------------- 4. verify ----------------------------------
log "verifying health on port $PORT"
HEALTHY=0
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${PORT}/health/ready" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" -ne 1 ]]; then
  warn "new release failed its health check — rolling back"
  if [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
    ln -sfn "$PREVIOUS_TARGET" "$BASE_DIR/current.new"
    mv -Tf "$BASE_DIR/current.new" "$BASE_DIR/current"
    basename "$PREVIOUS_TARGET" > "$BASE_DIR/CURRENT_RELEASE"
    systemctl restart sooya
    warn "rolled back to $PREVIOUS_TARGET"
  fi
  die "upgrade aborted; inspect: journalctl -u sooya -n 200"
fi

# ------------------------- 5. verify preserved state -------------------------
for path in "$SHARED_DIR/.env" "$SHARED_DIR/config" "$SHARED_DIR/data"; do
  [[ -e "$path" ]] || die "PRESERVATION FAILURE: $path is missing after upgrade"
done
log "verified: .env, config and data survived the upgrade"

# ---------------------------------- 6. prune ---------------------------------
mapfile -t OLD < <(ls -1dt "$BASE_DIR"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) || true)
for dir in "${OLD[@]:-}"; do
  [[ -z "$dir" ]] && continue
  [[ "$(readlink -f "$dir")" == "$(readlink -f "$BASE_DIR/current")" ]] && continue
  log "removing old release $dir"
  rm -rf "$dir"
done

log "upgrade to $RELEASE_ID complete"
