#!/usr/bin/env bash
# =============================================================================
# SOOYA — upgrade to a new release.
#
# Guarantees:
#   * .env, config/, data/, media, database, persona and model configuration
#     live in $BASE_DIR/shared and are NEVER touched by an upgrade;
#   * a verified, WAL-consistent backup is taken before switching;
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
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$SHARED_DIR/assets/stickers" "$SHARED_DIR/data/references"

PREVIOUS_TARGET=""
if [[ -L "$BASE_DIR/current" ]]; then
  PREVIOUS_TARGET="$(readlink -f "$BASE_DIR/current")"
  log "current release: $PREVIOUS_TARGET"
fi

PORT="$(grep -E '^PORT=' "$SHARED_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8788}"

# ------------------------- 1. back up before touching anything ---------------
DB="$SHARED_DIR/data/database/sooya.db"
if [[ -f "$DB" ]]; then
  BACKUP_HELPER="$SOURCE_DIR/deploy/backup.sh"
  [[ -f "$BACKUP_HELPER" ]] || die "backup helper missing: $BACKUP_HELPER"
  log "creating a verified pre-upgrade backup"
  # backup.sh first tries the live admin API, then SQLite's own backup APIs. It
  # deliberately fails closed rather than copying a live WAL database by hand.
  bash "$BACKUP_HELPER" --dir "$BASE_DIR" --out "$SHARED_DIR/data/backups" --keep 14 || \
    die "pre-upgrade backup failed; upgrade was not started"
else
  warn "no database found yet; skipping backup"
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
log "installing build dependencies"
npm ci --build-from-source=better-sqlite3
log "building"
npm run build -w @sooya/server
npm run build -w @sooya/web
rm -rf "$RELEASE_DIR/public"
cp -r "$RELEASE_DIR/packages/web/dist" "$RELEASE_DIR/public"

# Reinstall from the lockfile instead of pruning a workspace tree. npm prune can
# remove a dependency that was placed in a workspace-local node_modules directory.
log "installing production dependencies"
rm -rf "$RELEASE_DIR/node_modules" "$RELEASE_DIR/packages/server/node_modules" "$RELEASE_DIR/packages/web/node_modules"
npm ci --omit=dev --build-from-source=better-sqlite3
node -e "require(require.resolve('better-sqlite3', { paths: [process.cwd() + '/packages/server'] })); console.log('better-sqlite3 runtime dependency verified')"

chown -R "$SERVICE_USER":"$SERVICE_USER" "$RELEASE_DIR"

# --------------------- 2b. native module gate (hard stop) --------------------
# Incident 2026-07-31: a release whose better_sqlite3.node was missing became
# `current`, the app read "cannot load the module" as "the database is corrupt",
# renamed the live database away and served an empty one. Loading the module is
# not enough — the ABI can mismatch — so the gate opens a real database, writes
# to it and integrity-checks it, AS THE USER THAT WILL RUN THE SERVICE. Nothing
# becomes `current` until that passes; the old release keeps serving.
log "verifying the native sqlite module in the new release"
PROBE_DIR="$(mktemp -d)"
chown "$SERVICE_USER":"$SERVICE_USER" "$PROBE_DIR"
# sudo resets PATH to secure_path, which may not contain the node the service uses.
NODE_BIN="$(command -v node)" || die "node is not on PATH; cannot verify the release"
# "the probe could not run" and "the probe says the module is broken" are
# different facts and must not share a message. Without this check a host
# missing sudo (or denying it by policy) reports a broken native module on
# every upgrade, sending the operator after a problem that does not exist.
# Refusing to switch is still correct — an unverifiable release must not become
# `current` — but the reason has to be the true one.
command -v sudo >/dev/null 2>&1 \
  || die "sudo is required to verify the release as $SERVICE_USER but is not installed — not switching, the current release keeps serving"
if ! sudo -u "$SERVICE_USER" env PROBE_DIR="$PROBE_DIR" HOME="$PROBE_DIR" "$NODE_BIN" -e '
  const path = require("path");
  const Database = require(require.resolve("better-sqlite3", { paths: [process.cwd() + "/packages/server"] }));
  const db = new Database(path.join(process.env.PROBE_DIR, "probe.db"));
  db.exec("CREATE TABLE probe(x INTEGER)");
  db.prepare("INSERT INTO probe(x) VALUES (1)").run();
  if (db.pragma("integrity_check")[0].integrity_check !== "ok") throw new Error("probe database unhealthy");
  db.close();
  console.log("better-sqlite3 opens and writes a database as the service user");
'; then
  rm -rf "$PROBE_DIR"
  die "the new release cannot open a SQLite database (broken native module) — not switching, the current release keeps serving"
fi
rm -rf "$PROBE_DIR"

# ---------------------------------- 3. switch --------------------------------
log "switching the current symlink"
ln -sfn "$RELEASE_DIR" "$BASE_DIR/current.new"
mv -Tf "$BASE_DIR/current.new" "$BASE_DIR/current"
chown -h "$SERVICE_USER":"$SERVICE_USER" "$BASE_DIR/current"
echo "$RELEASE_ID" > "$BASE_DIR/CURRENT_RELEASE"

mkdir -p /etc/systemd/system/sooya.service.d
cat > /etc/systemd/system/sooya.service.d/assets.conf <<EOF
[Service]
Environment=SOOYA_ASSETS_DIR=$SHARED_DIR/assets/stickers
Environment=SOOYA_REFERENCES_DIR=$SHARED_DIR/data/references
EOF
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
for path in "$SHARED_DIR/.env" "$SHARED_DIR/config" "$SHARED_DIR/data" "$SHARED_DIR/assets/stickers" "$SHARED_DIR/data/references"; do
  [[ -e "$path" ]] || die "PRESERVATION FAILURE: $path is missing after upgrade"
done
log "verified: .env, config, data and private media sources survived the upgrade"

# ---------------------------------- 6. prune ---------------------------------
mapfile -t OLD < <(ls -1dt "$BASE_DIR"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) || true)
for dir in "${OLD[@]:-}"; do
  [[ -z "$dir" ]] && continue
  [[ "$(readlink -f "$dir")" == "$(readlink -f "$BASE_DIR/current")" ]] && continue
  log "removing old release $dir"
  rm -rf "$dir"
done

log "upgrade to $RELEASE_ID complete"
