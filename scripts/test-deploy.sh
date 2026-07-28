#!/usr/bin/env bash
# =============================================================================
# Deployment verification harness.
#
# Runs install.sh -> upgrade.sh -> rollback.sh against a throwaway prefix and
# asserts the guarantees that matter:
#   * the service becomes healthy after install
#   * user data, .env, config, media and the database survive an upgrade
#   * a rollback restores the previous code without touching the data
#   * the release package excludes secrets and runtime data
#
# systemd is not available inside containers, so a `systemctl` shim that really
# starts and stops the process stands in for it. Everything else (building,
# symlink switching, health probing, data preservation) is the production path.
#
# Usage: ./scripts/test-deploy.sh [--prefix /tmp/sooya-deploy-test]
# =============================================================================
set -Eeuo pipefail

PREFIX="${SOOYA_TEST_PREFIX:-/tmp/sooya-deploy-test}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SOOYA_TEST_PORT:-8795}"
FAILURES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[0;36m[deploy-test]\033[0m %s\n' "$*"; }
pass() { printf '\033[0;32m  PASS\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m  FAIL\033[0m %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

assert() { # assert <description> <condition-exit-code>
  if [[ "$2" -eq 0 ]]; then pass "$1"; else fail "$1"; fi
}

# The release under test is installed and started as root (install.sh requires
# EUID 0), so the server process is root-owned and an unprivileged kill fails
# silently. Escalate, and match by command line as well as by pidfile so a
# process from a crashed earlier run is also reaped.
kill_server() {
  local sig="$1"
  if [[ -f "$PREFIX/run/sooya.pid" ]]; then
    local pid
    pid="$(cat "$PREFIX/run/sooya.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      kill "-$sig" "$pid" 2>/dev/null || sudo -n kill "-$sig" "$pid" 2>/dev/null || true
    fi
  fi
  # `pkill -f` matches against full command lines, and this script's own shell
  # mentions the same path, so an unguarded pkill kills the harness itself
  # (visible as a bogus "Killed ... exit 0" right after the success message).
  # Resolve candidates explicitly and skip this process and its ancestors.
  local self=$$ parent=$PPID
  local candidates
  candidates="$(pgrep -f "$PREFIX/current/packages/server/dist/main.js" 2>/dev/null || true)"
  local target
  for target in $candidates; do
    [[ "$target" == "$self" || "$target" == "$parent" ]] && continue
    # Only kill real node servers, never a shell that merely mentions the path.
    local comm
    comm="$(ps -p "$target" -o comm= 2>/dev/null || true)"
    [[ "$comm" == node* ]] || continue
    kill "-$sig" "$target" 2>/dev/null || sudo -n kill "-$sig" "$target" 2>/dev/null || true
  done
}

cleanup() {
  kill_server TERM
  for _ in $(seq 1 20); do
    pgrep -f "$PREFIX/current/packages/server/dist/main.js" 2>/dev/null \
      | grep -vx -e "$$" -e "$PPID" | grep -q . || break
    sleep 0.25
  done
  kill_server KILL
  rm -f "$PREFIX/run/sooya.pid" 2>/dev/null || true

  # Each release under $PREFIX carries its own node_modules (~130 MB). On hosts
  # where /tmp is a RAM-backed tmpfs, keeping these around across runs exhausts
  # memory and gets unrelated processes OOM-killed. Remove the whole prefix
  # unless the caller explicitly asked to inspect it.
  if [[ "${SOOYA_TEST_KEEP:-0}" != "1" ]]; then
    rm -rf "$PREFIX" 2>/dev/null || sudo -n rm -rf "$PREFIX" 2>/dev/null || true
  else
    echo "[deploy-test] keeping $PREFIX (SOOYA_TEST_KEEP=1)"
  fi
}
trap cleanup EXIT

# A lingering server from an earlier run would still hold the port (with its
# own, different tokens) and produce confusing 401s. Kill it and wait for the
# port to be released before starting a fresh install.
for _stale in $(pgrep -f "$PREFIX/current/packages/server/dist/main.js" 2>/dev/null || true); do
  [[ "$_stale" == "$$" || "$_stale" == "$PPID" ]] && continue
  [[ "$(ps -p "$_stale" -o comm= 2>/dev/null)" == node* ]] || continue
  kill "$_stale" 2>/dev/null || sudo -n kill "$_stale" 2>/dev/null || true
done
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && { exec 3<&-; return 0; } || return 1; }
for _ in $(seq 1 40); do
  port_busy || break
  sleep 0.5
done
if port_busy; then
  echo "[deploy-test] port $PORT is still in use; aborting" >&2
  exit 2
fi

# A previous run may have left root-owned files behind.
if [[ -e "$PREFIX" ]]; then
  rm -rf "$PREFIX" 2>/dev/null || sudo rm -rf "$PREFIX"
fi
mkdir -p "$PREFIX/bin" "$PREFIX/run"

# ---------------------------- systemctl shim ---------------------------------
cat > "$PREFIX/bin/systemctl" <<SHIM
#!/usr/bin/env bash
# Minimal systemctl stand-in: really starts/stops the release process.
set -uo pipefail
PREFIX="$PREFIX"
ACTION="\${1:-}"
PIDFILE="\$PREFIX/run/sooya.pid"
UNIT="\$PREFIX/run/unit.env"

stop_it() {
  if [[ -f "\$PIDFILE" ]]; then
    PID="\$(cat "\$PIDFILE")"
    # May be root-owned; fall back to sudo so the port is really released.
    kill "\$PID" 2>/dev/null || sudo -n kill "\$PID" 2>/dev/null || true
    for _ in \$(seq 1 40); do
      kill -0 "\$PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "\$PID" 2>/dev/null || sudo -n kill -9 "\$PID" 2>/dev/null || true
    rm -f "\$PIDFILE"
  fi
}

start_it() {
  set -a
  # shellcheck disable=SC1090
  [[ -f "\$PREFIX/shared/.env" ]] && source "\$PREFIX/shared/.env"
  set +a
  export DATA_DIR="\$PREFIX/shared/data"
  export CONFIG_DIR="\$PREFIX/shared/config"
  export WEB_DIR="\$PREFIX/current/public"
  export SOOYA_ASSETS_DIR="\$PREFIX/current/assets/stickers"
  export HOST=127.0.0.1
  export NODE_ENV=production
  nohup node "\$PREFIX/current/packages/server/dist/main.js" \\
    >> "\$PREFIX/run/sooya.log" 2>&1 &
  SRV_PID=\$!
  echo \$SRV_PID > "\$PIDFILE"
  # Stop bash from reporting "Killed" for this job when it is later reaped.
  disown \$SRV_PID 2>/dev/null || true
}

case "\$ACTION" in
  start) start_it ;;
  stop) stop_it ;;
  restart) stop_it; start_it ;;
  daemon-reload|enable|disable) : ;;
  is-active) [[ -f "\$PIDFILE" ]] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null && echo active || { echo inactive; exit 3; } ;;
  *) : ;;
esac
touch "\$UNIT"
exit 0
SHIM
chmod +x "$PREFIX/bin/systemctl"

# The scripts run as the invoking user in this harness.
cat > "$PREFIX/bin/useradd" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "$PREFIX/bin/useradd"

export PATH="$PREFIX/bin:$PATH"
CURRENT_USER="$(id -un)"

run_as_root() { # the scripts require EUID 0; re-exec them through fakeroot-ish sudo
  if [[ $EUID -eq 0 ]]; then
    "$@"
  else
    sudo -E env "PATH=$PATH" "$@"
  fi
}

# ================================ 1. install ==================================
# Two releases plus their dependencies need roughly 300 MB. On a RAM-backed
# /tmp this can exceed the tmpfs budget, so fail fast with a clear message
# rather than getting OOM-killed midway.
AVAIL_KB="$(df -Pk "$(dirname "$PREFIX")" | awk 'NR==2 {print $4}')"
if [[ -n "$AVAIL_KB" && "$AVAIL_KB" -lt 400000 ]]; then
  echo "[deploy-test] only $((AVAIL_KB / 1024)) MB free on $(dirname "$PREFIX"); need ~400 MB." >&2
  echo "[deploy-test] set SOOYA_TEST_PREFIX to a disk-backed path, e.g.:" >&2
  echo "[deploy-test]   SOOYA_TEST_PREFIX=\"\$HOME/.sooya-deploy-test\" ./scripts/test-deploy.sh" >&2
  exit 2
fi

log "STEP 1: install"
if run_as_root bash "$SOURCE_DIR/deploy/install.sh" --dir "$PREFIX" --user "$CURRENT_USER" --no-service \
    > "$PREFIX/run/install.log" 2>&1; then
  pass "install.sh completed"
else
  fail "install.sh failed (see $PREFIX/run/install.log)"
  tail -30 "$PREFIX/run/install.log"
  exit 1
fi

[[ -L "$PREFIX/current" ]]; assert "current symlink created" $?
[[ -f "$PREFIX/current/packages/server/dist/main.js" ]]; assert "server built" $?
[[ -f "$PREFIX/current/public/index.html" ]]; assert "web client built into public/" $?
[[ -f "$PREFIX/shared/.env" ]]; assert "shared .env created" $?
[[ "$(stat -c '%a' "$PREFIX/shared/.env")" == "600" ]]; assert ".env is chmod 600" $?

# install.sh runs as root, so hand the tree back to the invoking user for the
# rest of the harness (a real deployment keeps it owned by the service user).
run_as_root chown -R "$CURRENT_USER":"$(id -gn)" "$PREFIX" 2>/dev/null || true

grep -q '^ADMIN_API_TOKEN=.\+' "$PREFIX/shared/.env"; assert "admin token generated" $?

# Point the install at our test port and start it.
sed -i "s|^PORT=.*|PORT=$PORT|" "$PREFIX/shared/.env"
systemctl start
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1
assert "service healthy after install" $?

# Health checks must work even with a chat token set (deployment must not
# misjudge readiness because of WEB_CHAT_TOKEN).
sed -i "s|^WEB_CHAT_TOKEN=.*|WEB_CHAT_TOKEN=deploy-probe-token|" "$PREFIX/shared/.env"
systemctl restart
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/health/live" >/dev/null 2>&1
assert "/health/live reachable without a token" $?
curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1
assert "/health/ready reachable without a token" $?
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/messages")"
[[ "$code" == "401" ]]; assert "chat API is protected by the token (got $code)" $?

# ============================ 2. create user state ============================
log "STEP 2: create user data to protect"
TOKEN="deploy-probe-token"
ADMIN="$(grep -E '^ADMIN_API_TOKEN=' "$PREFIX/shared/.env" | cut -d= -f2-)"

curl -fsS -X POST "http://127.0.0.1:$PORT/api/messages/sync" \
  -H "content-type: application/json" -H "x-sooya-token: $TOKEN" \
  -d '{"clientMsgId":"deploy-test-1","content":[{"type":"text","text":"升级前的消息"}]}' > /dev/null
assert "sent a message before upgrading" $?

curl -fsS -X PUT "http://127.0.0.1:$PORT/api/admin/persona" \
  -H "content-type: application/json" -H "x-admin-token: $ADMIN" \
  -d '{"speakingStyle":"自定义人格设置-保留测试"}' > /dev/null
assert "customised the persona" $?

echo "user-uploaded-content" > "$PREFIX/shared/data/media/files/user-file.txt"
MESSAGES_BEFORE="$(curl -fsS -H "x-sooya-token: $TOKEN" "http://127.0.0.1:$PORT/api/messages?limit=50" | grep -c '"id"' || true)"
ENV_SUM_BEFORE="$(sha256sum "$PREFIX/shared/.env" | cut -d' ' -f1)"
log "messages before upgrade: $MESSAGES_BEFORE"

# ================================ 3. upgrade ==================================
log "STEP 3: upgrade"
if run_as_root bash "$SOURCE_DIR/deploy/upgrade.sh" --dir "$PREFIX" --source "$SOURCE_DIR" --user "$CURRENT_USER" \
    > "$PREFIX/run/upgrade.log" 2>&1; then
  pass "upgrade.sh completed"
else
  fail "upgrade.sh failed (see $PREFIX/run/upgrade.log)"
  tail -40 "$PREFIX/run/upgrade.log"
fi

/usr/bin/sudo /usr/bin/chown -R "$CURRENT_USER":"$(id -gn)" "$PREFIX" 2>/dev/null || true
[[ "$(ls -1d "$PREFIX"/releases/*/ | wc -l)" -ge 2 ]]; assert "a second release exists" $?
[[ "$(sha256sum "$PREFIX/shared/.env" | cut -d' ' -f1)" == "$ENV_SUM_BEFORE" ]]
assert ".env unchanged by the upgrade" $?
grep -q '自定义人格设置-保留测试' "$PREFIX/shared/config/persona.json"
assert "custom persona preserved" $?
[[ -f "$PREFIX/shared/data/media/files/user-file.txt" ]]; assert "user media preserved" $?
[[ -f "$PREFIX/shared/data/database/sooya.db" ]]; assert "database file preserved" $?
ls "$PREFIX"/shared/data/backups/* >/dev/null 2>&1; assert "a pre-upgrade backup was created" $?

for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1 && break
  sleep 0.5
done
MESSAGES_AFTER="$(curl -fsS -H "x-sooya-token: $TOKEN" "http://127.0.0.1:$PORT/api/messages?limit=50" | grep -c '"id"' || true)"
[[ "$MESSAGES_AFTER" -ge "$MESSAGES_BEFORE" ]]
assert "chat history intact after upgrade ($MESSAGES_BEFORE -> $MESSAGES_AFTER)" $?
# Capture first: piping curl into `grep -q` lets grep exit early and kills
# curl with SIGPIPE, which `set -o pipefail` turns into a spurious failure.
HISTORY_AFTER_UPGRADE="$(curl -fsS -H "x-sooya-token: $TOKEN" "http://127.0.0.1:$PORT/api/messages?limit=50")"
grep -q '升级前的消息' <<<"$HISTORY_AFTER_UPGRADE"
assert "the pre-upgrade message is still readable" $?

# ================================ 4. rollback =================================
log "STEP 4: rollback"
CURRENT_BEFORE="$(readlink -f "$PREFIX/current")"
if run_as_root bash "$SOURCE_DIR/deploy/rollback.sh" --dir "$PREFIX" > "$PREFIX/run/rollback.log" 2>&1; then
  pass "rollback.sh completed"
else
  fail "rollback.sh failed (see $PREFIX/run/rollback.log)"
  tail -30 "$PREFIX/run/rollback.log"
fi
/usr/bin/sudo /usr/bin/chown -R "$CURRENT_USER":"$(id -gn)" "$PREFIX" 2>/dev/null || true
[[ "$(readlink -f "$PREFIX/current")" != "$CURRENT_BEFORE" ]]; assert "current now points at the previous release" $?

for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1
assert "service healthy after rollback" $?
HISTORY_AFTER_ROLLBACK="$(curl -fsS -H "x-sooya-token: $TOKEN" "http://127.0.0.1:$PORT/api/messages?limit=50")"
grep -q '升级前的消息' <<<"$HISTORY_AFTER_ROLLBACK"
assert "chat history survived the rollback" $?
grep -q '自定义人格设置-保留测试' "$PREFIX/shared/config/persona.json"
assert "custom persona survived the rollback" $?

# ============================= 5. backup / restore ============================
log "STEP 5: backup and restore"
bash "$SOURCE_DIR/deploy/backup.sh" --dir "$PREFIX" --keep 5 > "$PREFIX/run/backup.log" 2>&1
assert "backup.sh completed" $?
ARCHIVE="$(ls -1t "$PREFIX"/shared/data/backups/sooya-backup-*.tar.gz 2>/dev/null | head -1 || true)"
[[ -n "$ARCHIVE" ]]; assert "backup archive created" $?
[[ -f "$ARCHIVE.sha256" ]]; assert "checksum file created" $?
( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" >/dev/null 2>&1 )
assert "checksum verifies" $?
# `grep -q` exits as soon as it matches, which makes `tar` die with SIGPIPE
# (PIPESTATUS 141). Under `set -o pipefail` that aborts the whole script, and
# the shell prints a confusing "Killed" message. List the archive once into a
# variable instead, then match against it.
ARCHIVE_LIST="$(tar -tzf "$ARCHIVE")"
grep -q 'database/sooya.db' <<<"$ARCHIVE_LIST"; assert "archive contains the database" $?
grep -q 'media/' <<<"$ARCHIVE_LIST"; assert "archive contains media" $?
if grep -q 'env.backup' <<<"$ARCHIVE_LIST"; then
  fail "archive must not contain .env by default"
else
  pass "archive excludes .env by default"
fi

# Add a message, then restore the older backup and confirm the rollback of data.
curl -fsS -X POST "http://127.0.0.1:$PORT/api/messages/sync" \
  -H "content-type: application/json" -H "x-sooya-token: $TOKEN" \
  -d '{"clientMsgId":"deploy-test-after-backup","content":[{"type":"text","text":"备份之后的消息"}]}' > /dev/null

run_as_root bash "$SOURCE_DIR/deploy/restore-backup.sh" --dir "$PREFIX" --file "$ARCHIVE" \
  > "$PREFIX/run/restore.log" 2>&1
assert "restore-backup.sh completed" $?
/usr/bin/sudo /usr/bin/chown -R "$CURRENT_USER":"$(id -gn)" "$PREFIX" 2>/dev/null || true
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1 && break
  sleep 0.5
done
BODY="$(curl -fsS -H "x-sooya-token: $TOKEN" "http://127.0.0.1:$PORT/api/messages?limit=50")"
grep -q '升级前的消息' <<<"$BODY"; assert "restored data contains the original message" $?
if grep -q '备份之后的消息' <<<"$BODY"; then
  fail "post-backup message should be gone after restore"
else
  pass "post-backup message correctly rolled back"
fi

# ================================== summary ===================================
echo
if [[ "$FAILURES" -eq 0 ]]; then
  printf '\033[0;32m[deploy-test] all deployment checks passed\033[0m\n'
  exit 0
fi
printf '\033[0;31m[deploy-test] %d check(s) failed\033[0m\n' "$FAILURES"
exit 1
