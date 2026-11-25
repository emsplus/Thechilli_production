#!/usr/bin/env bash
# Health of OUR containers, their memory/CPU, disk, and the last errors in the logs (read-only).
# Exit status: 0 = every expected service runs and is healthy and the router answers; 1 = something is wrong (listed under "PROBLEMS"),
# so it can be used from cron / monitoring.
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
set +e
BAD=0; PROBLEMS=""
problem() { BAD=$((BAD+1)); PROBLEMS="$PROBLEMS
  - $*"; }
say "project $PROJECT (mode $MODE)"
dc ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
echo; say "resources (limits in docker-compose.yml)"
ids=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")
# no ids: `docker stats` without arguments would list EVERY container on the host (other projects included)
if [ -n "$ids" ]; then docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' $ids; else warn "no running container in project $PROJECT"; fi
# every expected service must have a running, healthy container (a missing, exited, restarting or unhealthy one is a problem)
for s in db $APP_SERVICES $WEB_SERVICES caddy; do
  c=$(our_container "$s")
  if [ -z "$c" ]; then problem "$s: no running container"; continue; fi
  st=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} restarts={{.RestartCount}}' "$c" 2>/dev/null)
  case "$st" in "running healthy"*|"running -"*) ;; *) problem "$s: $st" ;; esac
done
echo; say "disk"; df -h "$BUNDLE_DIR" | tail -1
dr=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null); [ -n "$dr" ] && [ -d "$dr" ] && df -h "$dr" | tail -1
fk=$(df -Pk "$BUNDLE_DIR" | awk 'NR==2{printf "%d", $4/1024/1024}'); [ "${fk:-99}" -lt "${STATUS_MIN_FREE_GB:-5}" ] && problem "less than ${STATUS_MIN_FREE_GB:-5} GB free disk in $BUNDLE_DIR (updates and backups will refuse; see RUNBOOK: disk full)"
 with_timeout 30 docker system df 2>/dev/null | sed 's/^/  /' || true
echo; say "errors in the last ${SINCE:-1h} (ERROR / Traceback / Permission denied / FATAL)"
for s in $(dc ps --services 2>/dev/null); do
  n=$(dc logs --no-color --since "${SINCE:-1h}" "$s" 2>&1 | grep -E 'ERROR|Traceback|Permission denied|FATAL|panic' | grep -vc 'level":"info' )
  [ "${n:-0}" = 0 ] && continue
  warn "$s: $n line(s); last 3:"; dc logs --no-color --since "${SINCE:-1h}" "$s" 2>&1 | grep -E 'ERROR|Traceback|Permission denied|FATAL|panic' | tail -3 | cut -c1-300 | sed 's/^/    /'
done
p=$(envget STACK_HTTP_PORT); echo
for k in DOMAIN_SITE DOMAIN_ADMIN DOMAIN_PARTNER DOMAIN_APP DOMAIN_WAITER DOMAIN_API; do
  h=$(envget $k); path=/; [ $k = DOMAIN_API ] && path=/api/v1/health
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Host: $h" -H 'X-Forwarded-Proto: https' "http://127.0.0.1:$p$path")
  say "router  $h$path -> HTTP $c"
  case "$c" in 2??|3??) ;; *) problem "router $h$path answered HTTP $c" ;; esac
done
h=$(envget DOMAIN_SITE)   # the site host: only the sign-up app (web-public); the website is its own stack
c=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Host: $h" -H 'X-Forwarded-Proto: https' "http://127.0.0.1:$p/signup")
say "router  $h/signup -> HTTP $c (web-public)"
case "$c" in 2??|3??) ;; *) problem "router $h/signup answered HTTP $c" ;; esac
echo
if [ "$BAD" = 0 ]; then say "${c_grn}STATUS: OK${c_off}"; else printf '%s %sSTATUS: %s PROBLEM(S)%s%s\n' "$(date +%H:%M:%S)" "$c_red" "$BAD" "$c_off" "$PROBLEMS" >&2; fi
exit $(( BAD > 0 ))
