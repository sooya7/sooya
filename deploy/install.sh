#!/usr/bin/env bash
# =============================================================================
# SOOYA — native Linux installer (no Docker).
#
# Layout created:
#   /opt/sooya/releases/<timestamp>/   immutable code
#   /opt/sooya/current -> releases/... symlink used by systemd
#   /opt/sooya/shared/                 .env, config/, data/  (NEVER overwritten)
#
# Usage:  sudo ./deploy/install.sh [--dir /opt/sooya] [--user sooya] [--no-service]
# =============================================================================
set -Eeuo pipefail

BASE_DIR="/opt/sooya"
SERVICE_USER="sooya"
INSTALL_SERVICE=1
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[0;36m[sooya]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[sooya]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[sooya]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BASE_DIR="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "please run as root (sudo)"

# ------------------------------- prerequisites -------------------------------
command -v node >/dev/null 2>&1 || die "node is required (20.10+)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "node 20+ required, found $(node -v)"
command -v npm >/dev/null 2>&1 || die "npm is required"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating system user $SERVICE_USER"
  useradd --system --create-home --home-dir "$BASE_DIR/home" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="$BASE_DIR/releases/$RELEASE_ID"
SHARED_DIR="$BASE_DIR/shared"

log "installing into $RELEASE_DIR"
mkdir -p "$RELEASE_DIR" "$SHARED_DIR"/{config,data} "$BASE_DIR/releases"

# ------------------------------- copy sources --------------------------------
# Runtime data is never copied from the source tree.
tar -C "$SOURCE_DIR" \
    --exclude='./node_modules' \
    --exclude='./.git' \
    --exclude='./data' \
    --exclude='./release' \
    --exclude='./.env' \
    --exclude='./e2e/test-results' \
    --exclude='./playwright-report' \
    -cf - . | tar -C "$RELEASE_DIR" -xf -

# ------------------------------ build the app --------------------------------
log "installing dependencies (this may take a few minutes)"
cd "$RELEASE_DIR"
npm ci --build-from-source=better-sqlite3

log "building server and web client"
npm run build -w @sooya/server
npm run build -w @sooya/web

# The server looks for the SPA in ./public next to the release root.
rm -rf "$RELEASE_DIR/public"
cp -r "$RELEASE_DIR/packages/web/dist" "$RELEASE_DIR/public"

log "pruning dev dependencies"
npm prune --omit=dev

# ------------------------- shared (preserved) state --------------------------
if [[ ! -f "$SHARED_DIR/.env" ]]; then
  log "creating $SHARED_DIR/.env from the example — edit it before going public"
  cp "$RELEASE_DIR/.env.example" "$SHARED_DIR/.env"
  {
    echo ""
    echo "# Auto-generated on install"
    echo "DATA_DIR=$SHARED_DIR/data"
    echo "CONFIG_DIR=$SHARED_DIR/config"
    echo "WEB_DIR=$BASE_DIR/current/public"
  } >> "$SHARED_DIR/.env"
  # Generate an admin token so the admin API is usable but not open.
  if command -v openssl >/dev/null 2>&1; then
    sed -i "s|^ADMIN_API_TOKEN=.*|ADMIN_API_TOKEN=$(openssl rand -hex 32)|" "$SHARED_DIR/.env"
  fi
  chmod 600 "$SHARED_DIR/.env"
else
  log "keeping existing $SHARED_DIR/.env"
fi

mkdir -p "$SHARED_DIR/data"/{database,media/{images,audio,stickers,files,tmp},backups,logs}
chown -R "$SERVICE_USER":"$SERVICE_USER" "$SHARED_DIR" "$RELEASE_DIR"
chmod 700 "$SHARED_DIR/data"

# --------------------------------- activate ----------------------------------
ln -sfn "$RELEASE_DIR" "$BASE_DIR/current"
chown -h "$SERVICE_USER":"$SERVICE_USER" "$BASE_DIR/current"
echo "$RELEASE_ID" > "$BASE_DIR/CURRENT_RELEASE"

if [[ "$INSTALL_SERVICE" -eq 1 ]]; then
  log "installing systemd unit"
  sed -e "s|/opt/sooya|$BASE_DIR|g" -e "s|^User=sooya|User=$SERVICE_USER|" -e "s|^Group=sooya|Group=$SERVICE_USER|" \
    "$RELEASE_DIR/deploy/sooya.service" > /etc/systemd/system/sooya.service
  systemctl daemon-reload
  systemctl enable sooya
  systemctl restart sooya

  log "waiting for the service to become ready"
  PORT="$(grep -E '^PORT=' "$SHARED_DIR/.env" | tail -1 | cut -d= -f2 || true)"
  PORT="${PORT:-8788}"
  for _ in $(seq 1 40); do
    # /health/ready deliberately requires no Admin token, so this probe
    # works regardless of whether a chat token is configured.
    if curl -fsS "http://127.0.0.1:${PORT}/health/ready" >/dev/null 2>&1; then
      log "SOOYA is ready on port $PORT"
      exit 0
    fi
    sleep 1
  done
  warn "service did not become ready in time; check: journalctl -u sooya -n 100"
  exit 1
fi

log "install complete (service not started; --no-service was given)"
