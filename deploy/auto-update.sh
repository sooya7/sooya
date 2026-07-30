#!/usr/bin/env bash
# =============================================================================
# SOOYA — deploy whatever `main` points at, if it moved.
#
# This is a thin wrapper. upgrade.sh already does the dangerous parts: it takes a
# verified WAL-consistent backup before touching anything, keeps the previous
# release on disk, health-checks the new one and restores the old one by itself
# if that check fails. So all this script decides is WHETHER to call it.
#
# It is safe to run every minute: if the remote commit already matches what is
# deployed it exits without touching the service, and flock keeps two runs from
# overlapping.
#
# Usage: sudo ./deploy/auto-update.sh [options]
#   --dir /opt/sooya          deployment root
#   --repo <url>              git remote (default: origin of the source clone)
#   --branch main             branch to follow
#   --src /opt/sooya/src      git clone this script maintains
#   --require-green           refuse a commit whose GitHub checks are not green
#   --once                    (default) one pass, then exit
# =============================================================================
set -Eeuo pipefail

BASE_DIR="/opt/sooya"
BRANCH="main"
SRC_DIR=""
REPO_URL=""
REQUIRE_GREEN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BASE_DIR="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --src) SRC_DIR="$2"; shift 2 ;;
    --require-green) REQUIRE_GREEN=1; shift ;;
    --once) shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

SRC_DIR="${SRC_DIR:-$BASE_DIR/src}"
STATE_FILE="$BASE_DIR/shared/.deployed-commit"
LOCK_FILE="/run/sooya-auto-update.lock"

log()  { printf '[auto-update] %s\n' "$*"; }
die()  { printf '[auto-update] %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "please run as root (sudo)"
[[ -d "$BASE_DIR/shared" ]] || die "$BASE_DIR/shared not found — run install.sh first"

# Serialize. A timer that fires while an upgrade is still running must not start
# a second one: exit quietly rather than queueing up behind it.
exec 9>"$LOCK_FILE"
flock -n 9 || { log "another run holds the lock; nothing to do"; exit 0; }

if [[ ! -d "$SRC_DIR/.git" ]]; then
  [[ -n "$REPO_URL" ]] || die "$SRC_DIR is not a clone yet; pass --repo <url> once"
  log "cloning $REPO_URL into $SRC_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi

git -C "$SRC_DIR" remote set-head origin -a >/dev/null 2>&1 || true
log "fetching $BRANCH"
git -C "$SRC_DIR" fetch --prune origin "$BRANCH" || die "fetch failed; leaving the running release alone"

REMOTE_SHA="$(git -C "$SRC_DIR" rev-parse "origin/$BRANCH")"
DEPLOYED_SHA="$(cat "$STATE_FILE" 2>/dev/null || true)"

if [[ "$REMOTE_SHA" == "$DEPLOYED_SHA" ]]; then
  log "already on ${REMOTE_SHA:0:8}; nothing to do"
  exit 0
fi

SHORT_DEPLOYED="${DEPLOYED_SHA:0:8}"
log "remote is ${REMOTE_SHA:0:8}, deployed is ${SHORT_DEPLOYED:-none}"

if (( REQUIRE_GREEN )); then
  # Deliberately fails closed: if the check status cannot be read, do not deploy.
  SLUG="$(git -C "$SRC_DIR" remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
  AUTH=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
  RUNS="$(curl -fsS "${AUTH[@]}" \
    "https://api.github.com/repos/$SLUG/commits/$REMOTE_SHA/check-runs" 2>/dev/null)" ||
    die "cannot read checks for ${REMOTE_SHA:0:8} (private repo needs GITHUB_TOKEN); not deploying"
  # No jq dependency on a small box: count conclusions with grep.
  TOTAL="$(printf '%s' "$RUNS" | grep -o '"conclusion":' | wc -l)"
  GOOD="$(printf '%s' "$RUNS" | grep -o '"conclusion": *"\(success\|skipped\|neutral\)"' | wc -l)"
  (( TOTAL > 0 )) || die "no checks reported for ${REMOTE_SHA:0:8}; not deploying"
  (( TOTAL == GOOD )) || die "checks are not green for ${REMOTE_SHA:0:8} ($GOOD/$TOTAL); not deploying"
  log "checks are green ($GOOD/$TOTAL)"
fi

log "checking out ${REMOTE_SHA:0:8}"
git -C "$SRC_DIR" reset --hard "$REMOTE_SHA"
git -C "$SRC_DIR" clean -fdx -e node_modules

log "handing over to upgrade.sh"
bash "$SRC_DIR/deploy/upgrade.sh" --dir "$BASE_DIR" --source "$SRC_DIR"

# Only recorded after upgrade.sh returns 0. If it failed it has already restored
# the previous release, and leaving the state file alone means the next run
# retries this commit rather than pretending it is live.
printf '%s\n' "$REMOTE_SHA" > "$STATE_FILE"
log "deployed ${REMOTE_SHA:0:8}"
