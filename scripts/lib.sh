# shellcheck shell=bash
# Shared helpers for the TheChilli.ai bundle scripts. Sourced, never run.
# SAFETY (shared host): every docker action goes through dc() (always `-p $PROJECT`) or through the guarded helpers below,
# which refuse any container / volume / network that does not belong to our compose project. Nothing here prunes, restarts
# the Docker daemon, edits /etc/docker or the host nginx.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_DIR="$BUNDLE_DIR"   # docker-compose*.yml, Caddyfile, .env and .env.secrets sit in the bundle root
LOG_DIR="$BUNDLE_DIR/logs"
STATE_FILE="$BUNDLE_DIR/.deploy-mode"     # behind-nginx | own-tls | local-test (written by deploy.sh)
# Logs can contain e-mail addresses, IPs and build output: owner-only (dir 0700, files 0600), also for logs written by older bundles.
(umask 077; mkdir -p "$LOG_DIR")
chmod 700 "$LOG_DIR" 2>/dev/null || true
chmod -R go-rwx "$LOG_DIR" 2>/dev/null || true

c_red=$'\033[31m'; c_yel=$'\033[33m'; c_grn=$'\033[32m'; c_bold=$'\033[1m'; c_off=$'\033[0m'
[ -t 1 ] || { c_red=; c_yel=; c_grn=; c_bold=; c_off=; }
say()  { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '%s %s[ok]%s %s\n' "$(date +%H:%M:%S)" "$c_grn" "$c_off" "$*"; }
warn() { printf '%s %s[warn]%s %s\n' "$(date +%H:%M:%S)" "$c_yel" "$c_off" "$*" >&2; }
die()  { printf '%s %s[FAIL]%s %s\n' "$(date +%H:%M:%S)" "$c_red" "$c_off" "$*" >&2; exit 1; }

# ---- one mutating operation at a time ----------------------------------------------------------------------------------
# deploy.sh, update.sh, backup.sh, restore.sh and down.sh call acquire_lock first. Two update.sh runs overlapped during live testing
# (2026-11-02): both moved src/<repo> to src/.prev-<repo>, so the second destroyed the previous source, and both rebuilt/recreated the same
# service. The lock is per bundle folder: flock(1) on .ops.lock when it exists (Linux: released by the kernel even on kill -9), else an atomic
# mkdir lock (.ops.lock.d, macOS) holding pid + process start time, so a dead holder is detected and the lock taken over.
# A child script of a holder (update.sh -> backup.sh) sees CHILLI_LOCK_HELD and does not lock again.
# LOCK_WAIT=<seconds> waits for the holder instead of failing at once. Exit status 75 (EX_TEMPFAIL) when busy: nothing was changed.
OPS_LOCK="$BUNDLE_DIR/.ops.lock"
_lock_mode=""
_lock_info() { printf 'pid=%s started=%s command=%s\n' "$$" "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
_pid_start() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/  */ /g' || true; }
release_lock() {
  case "$_lock_mode" in
    mkdir) [ "$(cat "$OPS_LOCK.d/pid" 2>/dev/null)" = "$$" ] && rm -rf "$OPS_LOCK.d" ;;
    flock) : > "$OPS_LOCK" 2>/dev/null ;;   # the kernel drops the lock itself when this process ends
  esac
  _lock_mode=""
}
_lock_busy() {  # HOLDER-INFO
  printf '%s %s[FAIL]%s another operation is already running on this stack (%s).\n' "$(date +%H:%M:%S)" "$c_red" "$c_off" "${1:-holder unknown}" >&2
  printf '       Nothing was changed. Wait for it to finish (scripts/status.sh; tail -f logs/*), then run this again (LOCK_WAIT=600 waits for it).\n' >&2
  printf '       If you are sure no deploy/update/backup/restore is running (holder dead, lock stuck): rm -rf %s %s.d\n' "$OPS_LOCK" "$OPS_LOCK" >&2
  exit 75
}
acquire_lock() {  # [DESCRIPTION]
  [ "${CHILLI_LOCK_HELD:-}" = "$BUNDLE_DIR" ] && return 0
  local desc="${1:-$(basename "$0") $*}" wait="${LOCK_WAIT:-0}" t0 holder pid st cur n
  t0=$(date +%s)
  if command -v flock >/dev/null 2>&1 && [ -z "${LOCK_FORCE_MKDIR:-}" ]; then
    exec 9>>"$OPS_LOCK" || die "cannot open the lock file $OPS_LOCK"
    if [ "$wait" -gt 0 ]; then flock -w "$wait" 9 || _lock_busy "$(head -1 "$OPS_LOCK" 2>/dev/null)"
    else flock -n 9 || _lock_busy "$(head -1 "$OPS_LOCK" 2>/dev/null)"; fi
    _lock_info "$desc" > "$OPS_LOCK"; _lock_mode=flock
  else
    n=0
    while ! mkdir "$OPS_LOCK.d" 2>/dev/null; do
      pid=$(cat "$OPS_LOCK.d/pid" 2>/dev/null || true); st=$(cat "$OPS_LOCK.d/start" 2>/dev/null || true)
      cur=""; [ -z "$pid" ] || cur=$(_pid_start "$pid")
      if [ -n "$pid" ] && [ -n "$cur" ] && [ "$cur" = "$st" ]; then   # alive, same process (not a reused pid)
        holder=$(head -1 "$OPS_LOCK.d/info" 2>/dev/null || true)
        [ "$wait" -gt 0 ] && [ $(( $(date +%s) - t0 )) -lt "$wait" ] && { sleep 2; continue; }
        _lock_busy "$holder"
      fi
      # no pid yet = the holder is between mkdir and writing its pid (give it 3 s); otherwise the holder is gone: take the lock over
      if [ -z "$pid" ] && [ "$n" -lt 3 ]; then n=$((n+1)); sleep 1; continue; fi
      warn "stale lock from a dead process (${pid:-no pid}): taking it over"
      mv "$OPS_LOCK.d" "$OPS_LOCK.d.stale.$$" 2>/dev/null && rm -rf "$OPS_LOCK.d.stale.$$"   # only one racer wins the rename
      n=0
    done
    printf '%s\n' "$$" > "$OPS_LOCK.d/pid"; _pid_start "$$" > "$OPS_LOCK.d/start"; _lock_info "$desc" > "$OPS_LOCK.d/info"
    _lock_mode="mkdir"
  fi
  export CHILLI_LOCK_HELD="$BUNDLE_DIR"
  trap release_lock EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
}

prune_logs() {  # script logs: deploy-*.log (one per deploy run) older than LOG_KEEP_DAYS (30) are deleted; logs/backup.log (cron appends forever) is rotated at 5 MB, 3 kept
  find "$LOG_DIR" -maxdepth 1 -name 'deploy-*.log' -mtime +"${LOG_KEEP_DAYS:-30}" -delete 2>/dev/null || true
  local f="$LOG_DIR/backup.log"
  if [ -f "$f" ] && [ "$(wc -c < "$f" | tr -d ' ')" -gt 5242880 ]; then
    mv -f "$f.2" "$f.3" 2>/dev/null || true; mv -f "$f.1" "$f.2" 2>/dev/null || true; mv -f "$f" "$f.1"; : > "$f"; chmod 600 "$f" "$f".? 2>/dev/null || true
  fi
}
check_free_space() {  # MIN_MB WHAT : refuse to start a disk-hungry step on a nearly full disk (0 = skip). Checks the bundle folder and Docker's data root.
  local need=$1 what=$2 free dockroot dfree
  [ "$need" -gt 0 ] 2>/dev/null || return 0
  free=$(df -Pk "$BUNDLE_DIR" | awk 'NR==2{printf "%d", $4/1024}')
  dockroot=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -n "$dockroot" ] && [ -d "$dockroot" ]; then dfree=$(df -Pk "$dockroot" 2>/dev/null | awk 'NR==2{printf "%d", $4/1024}'); [ "${dfree:-$free}" -lt "$free" ] && free=$dfree; fi
  [ "${free:-0}" -ge "$need" ] || die "$what: only ${free} MB free (< ${need} MB needed): nothing was changed. Free space of OUR project only (old backups/, 'docker image ls \"$PROJECT-*\"' :rollback tags; never 'docker system prune' on a shared host), or set MIN_FREE_MB=0 to skip this check"
}

# ---- mode and env file ---------------------------------------------------------------------------------------------
MODE="${MODE:-}"
[ -n "$MODE" ] || { [ -f "$STATE_FILE" ] && MODE="$(cat "$STATE_FILE")"; } || true
MODE="${MODE:-behind-nginx}"
ENV_FILE="$BUNDLE_DIR/.env"
[ "$MODE" = local-test ] && ENV_FILE="$BUNDLE_DIR/.env.localtest"

# envget NAME [FILE]: value of NAME in a dotenv file (same rules as docker compose for our files: KEY=VALUE, optional
# single/double quotes, no inline comments). No shell evaluation.
envget() {
  local f="${2:-$ENV_FILE}"
  [ -f "$f" ] || { printf ''; return 0; }
  python3 - "$1" "$f" <<'PY'
import sys
key, path = sys.argv[1], sys.argv[2]
val = ""
for line in open(path, encoding="utf-8"):
    line = line.rstrip("\n")
    if not line or line.lstrip().startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    if k.strip() != key:
        continue
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    val = v
print(val, end="")
PY
}

# envset NAME VALUE [FILE]: replace or append NAME=VALUE (keeps the file's mode).
envset() {
  local f="${3:-$ENV_FILE}"
  python3 - "$1" "$2" "$f" <<'PY'
import sys, os
key, val, path = sys.argv[1:4]
lines = open(path, encoding="utf-8").read().split("\n") if os.path.exists(path) else []
done = False
for i, l in enumerate(lines):
    if l.split("=", 1)[0].strip() == key and not l.lstrip().startswith("#"):
        lines[i] = f"{key}={val}"; done = True
if not done:
    if lines and lines[-1] == "": lines.insert(len(lines) - 1, f"{key}={val}")
    else: lines.append(f"{key}={val}")
open(path, "w", encoding="utf-8").write("\n".join(lines) + ("" if lines and lines[-1] == "" else "\n"))
PY
}

PROJECT="$(envget COMPOSE_PROJECT_NAME)"
PROJECT="${PROJECT:-chilli}"

# ---- guards ----------------------------------------------------------------------------------------------------------
guard_project() {  # our project names only: chilli or chilli-<suffix>
  case "$PROJECT" in chilli|chilli-[a-z0-9]*|production-thechilli|uat-thechilli) ;; *) die "refusing: compose project '$PROJECT' is not ours (must be chilli, chilli-*, production-thechilli or uat-thechilli)";; esac
  case "$PROJECT" in *[!a-z0-9-]*) die "refusing: bad project name '$PROJECT'";; esac
}
guard_container() {  # NAME -> refuses unless it is a container of our project
  local n="$1" p
  p="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$n" 2>/dev/null || true)"
  [ "$p" = "$PROJECT" ] || die "refusing: container '$n' is not part of compose project '$PROJECT'"
  case "$n" in "$PROJECT"-*) ;; *) die "refusing: container '$n' does not start with '$PROJECT-'";; esac
}
guard_volume() {  # NAME -> refuses unless it is a volume of our project
  local n="$1" p
  case "$n" in "${PROJECT}"_*) ;; *) die "refusing: volume '$n' does not start with '${PROJECT}_'";; esac
  p="$(docker volume inspect -f '{{ index .Labels "com.docker.compose.project" }}' "$n" 2>/dev/null || true)"
  [ "$p" = "$PROJECT" ] || die "refusing: volume '$n' is not labelled as compose project '$PROJECT'"
}
guard_project

# ---- compose wrapper ------------------------------------------------------------------------------------------------
compose_files() {
  local f=(-f docker-compose.yml)
  case "$MODE" in
    own-tls|local-test) die "mode $MODE is not part of this server layout (only behind-nginx: the one docker-compose.yml); the old tls/localtest compose files are in git history" ;;
  esac
  printf '%s\n' "${f[@]}"
}
dc() {  # docker compose, ALWAYS scoped to our project, our files and our env files
  local files=(); while IFS= read -r x; do files+=("$x"); done < <(compose_files)
  (cd "$COMPOSE_DIR" && docker compose -p "$PROJECT" "${files[@]}" --env-file "$ENV_FILE" --profile full "$@")
}
our_container() {  # SERVICE -> running container name of our project (empty if none)
  docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -n1
}

APP_SERVICES="pos-service platform-core marketing-service payments-service aggregator-service delivery-service"
WEB_SERVICES="web-public web-super-admin web-marketing web-business-admin waiter-app"
MIGRATIONS="pos-migrate platform-migrate marketing-migrate payments-migrate aggregator-migrate delivery-migrate"
DATABASES="pos platform marketing payments aggregator delivery"
# build order: one image at a time (shared host)
BUILD_ORDER="pos-service platform-core marketing-service delivery-service payments-service aggregator-service web-public web-super-admin web-marketing web-business-admin waiter-app"

wait_healthy() {  # TIMEOUT_SECONDS SERVICE... : waits until each service is healthy (or running when it has no healthcheck)
  local t="$1"; shift; local end=$(( $(date +%s) + t )) s c st
  for s in "$@"; do
    while :; do
      c="$(our_container "$s")"
      st=""
      # healthy (has a healthcheck) or running (has none); "starting"/"unhealthy"/missing keep waiting
      [ -n "$c" ] && st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || true)"
      case "$st" in healthy|running) break ;; esac
      if [ "$(date +%s)" -ge "$end" ]; then
        warn "$s not healthy after ${t}s (state: ${st:-missing})"
        if [ -n "$c" ]; then
          docker inspect -f '{{if .State.Health}}{{range .State.Health.Log}}{{.End}} exit={{.ExitCode}} {{printf "%.300s" .Output}}{{"\n"}}{{end}}{{end}}' "$c" 2>/dev/null | tail -3 | sed 's/^/      healthcheck: /'
          if docker inspect -f '{{if .State.Health}}{{range .State.Health.Log}}{{.Output}}{{end}}{{end}}' "$c" 2>/dev/null | grep -q 'exceeded timeout'; then
            warn "$s: the HEALTH CHECK TIMED OUT (the app may be fine but the host is busy): scripts/status.sh in a minute; raise its cpus in docker-compose.yml if it persists"
          fi
          docker logs --tail 5 "$c" 2>&1 | sed 's/^/      log: /'
        fi
        return 1
      fi
      sleep 3
    done
  done
}

listening_ports() {  # all host TCP ports in LISTEN state + ports published by any container (read-only)
  { if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://'
    elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://'
    fi
    docker ps --format '{{.Ports}}' 2>/dev/null | tr ',' '\n' | sed -n 's/.*:\([0-9][0-9]*\)->.*/\1/p'
  } | grep -E '^[0-9]+$' | sort -un
}
port_busy() { listening_ports | grep -qx "$1"; }

with_timeout() {  # SECONDS CMD... : run CMD, kill it after SECONDS (docker system df can take minutes on a busy host)
  local t=$1; shift
  "$@" & local p=$!
  ( sleep "$t"; kill "$p" 2>/dev/null ) >/dev/null 2>&1 & local w=$!
  local rc=0; wait "$p" 2>/dev/null || rc=$?
  kill "$w" 2>/dev/null || true; wait "$w" 2>/dev/null || true
  return $rc
}
