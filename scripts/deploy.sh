#!/usr/bin/env bash
# TheChilli.ai: install or re-deploy the whole stack on THIS host. Idempotent: run it again any time (nothing is regenerated,
# migrations and seeds are no-ops when up to date, images are rebuilt only when sources changed).
#
#   scripts/deploy.sh                 shared host (default): stack on 127.0.0.1:STACK_HTTP_PORT, TLS at the host nginx
#   scripts/deploy.sh --own-tls       a host of our own: the router takes 80/443 itself (Let's Encrypt or cert files)
#   scripts/deploy.sh --local-test    rehearsal on a workstation: *.localtest.me, project chilli-bundletest, self-signed edge nginx
#                               on 127.0.0.1:8443, mail catcher; uses .env.localtest (created from .env.example)
# Options: --force (continue although RAM/disk preflight fails), --skip-build (use existing images), --yes (no prompts),
#          --preflight-only (checks + .env validation only; changes nothing but STACK_HTTP_PORT in .env),
#          --accept-placeholder-prices (seed the built-in starter/growth/pro plans; edit prices later in Super Admin)
# Rules (shared host): only `docker compose -p <our project>`; never prune, never touch other containers, the Docker daemon
# or the host nginx; the only host port is 127.0.0.1:STACK_HTTP_PORT (local test: + the edge/mail ports on 127.0.0.1).
set -euo pipefail
cd "$(dirname "$0")/.."
FORCE=0; SKIP_BUILD=0; YES=0; PLACEHOLDER=0; MODE_ARG=behind-nginx; PREFLIGHT_ONLY=0
for a in "$@"; do
  case "$a" in
    --local-test) MODE_ARG=local-test ;;
    --own-tls) MODE_ARG=own-tls ;;
    --behind-host-nginx) MODE_ARG=behind-nginx ;;
    --force) FORCE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    --yes|-y) YES=1 ;;
    --accept-placeholder-prices) PLACEHOLDER=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $a (see --help)" >&2; exit 2 ;;
  esac
done
export MODE="$MODE_ARG"

# ---- local test: create .env.localtest from .env.example once (distinct project, names, subnets, ports)
if [ "$MODE" = local-test ] && [ ! -f .env.localtest ]; then
  umask 077
  sed -e 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=chilli-bundletest/' \
      -e 's/^DOMAIN_SITE=.*/DOMAIN_SITE=thechilli.localtest.me/' \
      -e 's/^DOMAIN_ADMIN=.*/DOMAIN_ADMIN=thechilli-admin.localtest.me/' \
      -e 's/^DOMAIN_PARTNER=.*/DOMAIN_PARTNER=thechilli-marketing.localtest.me/' \
      -e 's/^DOMAIN_APP=.*/DOMAIN_APP=app.thechilli.localtest.me/' \
      -e 's/^DOMAIN_WAITER=.*/DOMAIN_WAITER=waiter.thechilli.localtest.me/' \
      -e 's/^DOMAIN_API=.*/DOMAIN_API=api.thechilli.localtest.me/' \
      -e 's/^DOMAIN_ORDER=.*/DOMAIN_ORDER=order.thechilli.localtest.me/' \
      -e 's/^PUBLIC_PORT_SUFFIX=.*/PUBLIC_PORT_SUFFIX=:8443/' \
      -e 's/^DEFAULT_SUBNET=.*/DEFAULT_SUBNET=10.231.94.0\/24/' -e 's/^DEFAULT_IP_RANGE=.*/DEFAULT_IP_RANGE=10.231.94.128\/25/' -e 's/^PROXY_IP=.*/PROXY_IP=10.231.94.10/' \
      -e 's/^POS_BFF_SUBNET=.*/POS_BFF_SUBNET=10.231.95.0\/28/' -e 's/^POS_BFF_IP_RANGE=.*/POS_BFF_IP_RANGE=10.231.95.0\/29/' -e 's/^POS_BFF_WEB_IP=.*/POS_BFF_WEB_IP=10.231.95.10/' \
      -e 's/^POS_BFF_PROXY_IP=.*/POS_BFF_PROXY_IP=10.231.95.11/' \
      -e 's/^SMTP_FROM=.*/SMTP_FROM="Chilli Agent <no-reply@zonov.ai>"/' \
      -e 's/^MAIL_POLICY=.*/MAIL_POLICY=mailpit/' \
      .env.example > .env.localtest
  printf 'LOCALTEST_HTTPS_PORT=8443\nLOCALTEST_HTTP_PORT=8080\nLOCALTEST_MAILPIT_PORT=8026\n' >> .env.localtest
fi
if [ "$MODE" != local-test ] && [ ! -f .env ]; then
  umask 077; cp .env.example .env
  echo "Created .env from .env.example. Fill the MUST lines (SMTP_*, SSL_* paths), then run scripts/deploy.sh again." >&2; exit 1
fi
# .env written from an older .env.example: append the settings added since (with their example values; existing lines untouched)
upgrade_env() {
  local f=$1 added=""
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    k=${line%%=*}
    grep -q "^$k=" "$f" || { printf '%s\n' "$line" >> "$f"; added="$added $k"; }
  done < .env.example
  [ -z "$added" ] || echo "added to $(basename "$f") from .env.example (new settings, example values):$added"
}
if [ "$MODE" = local-test ]; then upgrade_env .env.localtest; else upgrade_env .env; fi
# shellcheck source=scripts/lib.sh
. scripts/lib.sh
prune_logs
acquire_lock "deploy.sh $*"   # one deploy/update/backup/restore/down at a time (exit 75 when busy)
echo "$MODE" > "$STATE_FILE"
RUN_LOG="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"
(umask 077; : >> "$RUN_LOG")   # created 0600 before tee appends to it
exec > >(tee -a "$RUN_LOG") 2>&1
say "${c_bold}TheChilli.ai deploy${c_off}: mode $MODE, project $PROJECT, env $ENV_FILE, log $RUN_LOG"
T0=$(date +%s)

# =====================================================================================================================
say "1/11 preflight"
command -v docker >/dev/null || die "docker is not installed"
command -v python3 >/dev/null || die "python3 is not installed (apt-get install -y python3)"
command -v openssl >/dev/null || die "openssl is not installed"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is your user in the docker group? newgrp docker)"
cv=$(docker compose version --short 2>/dev/null | sed 's/^v//') || die "docker compose v2 plugin is missing"
python3 - "$cv" <<'PY' || die "docker compose $cv is too old: need 2.24 or newer (for !reset / !override)"
import sys; v=[int(x) for x in sys.argv[1].split("-")[0].split(".")[:2]]; sys.exit(0 if v >= [2,24] else 1)
PY
ok "docker $(docker version -f '{{.Server.Version}}'), compose $cv, arch $(uname -m)"
MIN_DISK_GB=${MIN_DISK_GB:-40}; MIN_AVAIL_RAM_GB=${MIN_AVAIL_RAM_GB:-6}
free_gb=$(df -Pk "$BUNDLE_DIR" | awk 'NR==2{printf "%d", $4/1024/1024}')
dockroot=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
[ -d "$dockroot" ] && dfree=$(df -Pk "$dockroot" 2>/dev/null | awk 'NR==2{printf "%d", $4/1024/1024}') || dfree=$free_gb
[ "${dfree:-0}" -lt "$free_gb" ] && free_gb=$dfree
if [ "$free_gb" -lt "$MIN_DISK_GB" ]; then
  [ "$FORCE" = 1 ] && warn "only ${free_gb} GB free disk (< ${MIN_DISK_GB} GB): continuing because of --force" \
    || die "only ${free_gb} GB free disk (< ${MIN_DISK_GB} GB needed for images + build cache). Free space (our project only: scripts/down.sh; never 'docker system prune' on a shared host) or pass --force"
else ok "disk: ${free_gb} GB free"; fi
if [ -r /proc/meminfo ]; then
  avail_gb=$(awk '/MemAvailable/{printf "%d", $2/1024/1024}' /proc/meminfo); total_gb=$(awk '/MemTotal/{printf "%d", ($2/1024/1024)+0.5}' /proc/meminfo)
else avail_gb=$(( $(docker info -f '{{.MemTotal}}') / 1024 / 1024 / 1024 )); total_gb=$avail_gb; fi
# already running stack: its own memory counts as available for a re-deploy
ids=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")
mine_mb=0; [ -z "$ids" ] || mine_mb=$(docker stats --no-stream --format '{{.MemUsage}}' $ids 2>/dev/null | awk '{u=$1; v=u+0; if(u~/GiB/)v*=1024; else if(u~/KiB/)v/=1024; s+=v} END{printf "%d", s}')
avail_eff=$(( avail_gb + ${mine_mb:-0} / 1024 ))
if [ "$avail_eff" -lt "$MIN_AVAIL_RAM_GB" ]; then
  [ "$FORCE" = 1 ] && warn "only ${avail_eff} GiB RAM available (< ${MIN_AVAIL_RAM_GB}): continuing because of --force" \
    || die "only ${avail_eff} GiB RAM available (< ${MIN_AVAIL_RAM_GB} GiB; the stack is capped at about 4.6 GiB (uses about 1.5 GiB idle) plus a 2 GiB build). Wait until the other projects settle, add swap (sudo scripts/add-swap.sh) or pass --force"
else ok "memory: ${avail_eff} GiB available of ${total_gb} GiB"; fi
[ "$total_gb" -ge 15 ] || warn "host has ${total_gb} GiB RAM: 16 GiB recommended for a shared host"
load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}' || echo 0)
ncpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
python3 -c "import sys; sys.exit(0 if float('$load') < 2*$ncpu else 1)" || warn "load average $load on $ncpu CPUs: builds will be slow; better run when the host is quieter"
say "docker disk usage (all projects, read-only; skipped after 30 s):"; with_timeout 30 docker system df 2>/dev/null | sed 's/^/    /' || warn "docker system df did not answer within 30 s (skipped)"

# ---- port for the internal router: first free in 7080..7199 (ours counts as free)
want=$(envget STACK_HTTP_PORT); want=${want:-7080}
ours_port=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=caddy" --format '{{.Ports}}' | sed -n 's/.*:\([0-9]*\)->80\/tcp.*/\1/p' | head -1)
pick=""
for p in $want $(seq 7080 7199); do
  case " 22 80 443 1265 6780 6789 6790 8450 " in *" $p "*) continue ;; esac
  if [ "$p" = "${ours_port:-x}" ] || ! port_busy "$p"; then pick=$p; break; fi
done
[ -n "$pick" ] || die "no free port in 7080..7199 for the internal router"
[ "$pick" = "$want" ] || warn "STACK_HTTP_PORT $want is busy: using $pick"
envset STACK_HTTP_PORT "$pick"
ok "internal router port: 127.0.0.1:$pick"
if [ "$MODE" = local-test ]; then
  for k in LOCALTEST_HTTPS_PORT LOCALTEST_HTTP_PORT LOCALTEST_MAILPIT_PORT; do
    p=$(envget $k); mine=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Ports}}' | grep -c ":$p->" || true)
    [ "$mine" != 0 ] || ! port_busy "$p" || die "$k=$p is busy on this machine: change it in .env.localtest"
  done
fi
if [ "$MODE" = own-tls ]; then
  for p in 80 443; do
    mine=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Ports}}' | grep -c ":$p->" || true)
    [ "$mine" != 0 ] || ! port_busy "$p" || die "--own-tls needs ports 80/443 but $p is in use (shared host? run without --own-tls and use config/nginx/thechilli.conf)"
  done
elif [ "$MODE" = behind-nginx ] && ! port_busy 443; then
  warn "nothing listens on 443: is the host nginx running? (or use --own-tls on a host of our own)"
fi

# ---- DNS (warning only)
if [ "$MODE" != local-test ]; then
  pub=$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null \
        | xargs -I{} curl -s -m 2 -H 'X-aws-ec2-metadata-token: {}' http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
  for k in DOMAIN_SITE DOMAIN_ADMIN DOMAIN_PARTNER DOMAIN_APP DOMAIN_WAITER DOMAIN_API DOMAIN_ORDER; do
    d=$(envget $k); ip=$(python3 -c "import socket,sys; print(socket.gethostbyname(sys.argv[1]))" "$d" 2>/dev/null || true)
    if [ -z "$ip" ]; then warn "DNS: $d does not resolve yet (create the A record; $k)"
    elif [ -n "$pub" ] && [ "$ip" != "$pub" ]; then warn "DNS: $d -> $ip, but this host's public IP is $pub"
    else ok "DNS: $d -> $ip"; fi
  done
fi

# =====================================================================================================================
say "2/11 configuration check"
scripts/check-env.sh || die "fix .env first (see the lines above)"
[ "$PREFLIGHT_ONLY" = 1 ] && { ok "preflight only: stopping here (nothing built or started)"; exit 0; }

# =====================================================================================================================
say "3/11 secrets (generated on this host, never printed)"
cd "$COMPOSE_DIR"
umask 077
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing"
ok "one .env holds the settings and the generated secrets (existing values are never changed)"
envset COMPOSE_PROJECT_NAME "$PROJECT" "$ENV_FILE"
fernet() { python3 -c 'import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())'; }
[ -n "$(envget POS_MFA_ENCRYPTION_KEY "$ENV_FILE")" ] || envset POS_MFA_ENCRYPTION_KEY "$(fernet)" "$ENV_FILE"
[ -n "$(envget PLATFORM_MFA_ENCRYPTION_KEY "$ENV_FILE")" ] || envset PLATFORM_MFA_ENCRYPTION_KEY "$(fernet)" "$ENV_FILE"
[ -n "$(envget POS_PIN_PEPPER "$ENV_FILE")" ] || envset POS_PIN_PEPPER "$(openssl rand -hex 32)" "$ENV_FILE"
for k in AGGREGATOR_JWT_SECRET AGGREGATOR_INTERNAL_JWT_SECRET DELIVERY_WHATSAPP_APP_SECRET; do
  [ -n "$(envget $k "$ENV_FILE")" ] || envset $k "$(openssl rand -hex 32)" "$ENV_FILE"
done
ENV_FILE="$ENV_FILE" scripts/gen-env.sh --update >/dev/null   # adds the generated secrets and variables introduced by newer bundles; never changes existing values
chmod 600 "$ENV_FILE"
# owner-managed providers (SMTP, AI, WhatsApp: keep them in .env) -> .env.secrets (env_file of pos-service and platform-core); regenerated on every run
tmp=$(mktemp)
for k in SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_PASSWORD SMTP_FROM SMTP_TEST_TO GEMINI_API_KEY GEMINI_MODEL \
         WHATSAPP_PROVIDER WHATSAPP_PHONE_NUMBER_ID WHATSAPP_ACCESS_TOKEN WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN \
         AI_OCR_PROVIDER AI_STT_PROVIDER XAI_API_KEY GROK_API_KEY XAI_BASE_URL XAI_VISION_MODEL OPENAI_API_KEY OPENAI_BASE_URL WHISPER_MODEL \
         WHISPER_LANGUAGE AI_TEXT_PROVIDER XAI_TEXT_MODEL; do
  val=$(envget "$k"); [ -z "$val" ] || printf '%s=%s\n' "$k" "$val" >> "$tmp"
done
[ "$MODE" = local-test ] && printf 'MAILPIT_SMTP_HOST=mailpit\n' >> "$tmp"
cat "$tmp" > .env.secrets; rm -f "$tmp"; chmod 600 .env.secrets
ok ".env.secrets written ($(wc -l < .env.secrets | tr -d ' ') settings, mode 600)"
COMPOSE_ENV_FILE="$ENV_FILE" COMPOSE_SECRETS_FILE=.env.secrets SMTP_FROM="$(envget SMTP_FROM)" scripts/check-config.sh || die "check-config.sh failed"
cd "$BUNDLE_DIR"
STRICT_GENERATED=1 scripts/check-env.sh >/dev/null || { STRICT_GENERATED=1 scripts/check-env.sh; die "generated secrets failed the check"; }

# =====================================================================================================================
say "4/11 compose file check"
cfg_err=$(dc config -q 2>&1) || { echo "$cfg_err"; die "docker compose config failed"; }
if printf '%s' "$cfg_err" | grep -qi 'not set\|warn'; then echo "$cfg_err"; die "docker compose config printed warnings (unset variables)"; fi
ok "docker compose config: valid, no warnings"

# =====================================================================================================================
say "5/11 nginx site file (written here only; installing it is a manual step)"
render_nginx() {  # OUT UPSTREAM CERT_TOP KEY_TOP CERT_SUB KEY_SUB SUFFIX EDGE_HEALTH HOSTVAR
  python3 - "$@" <<'PY'
import sys, os
out, up, ct, kt, cs, ks, suf, edge, hostvar = sys.argv[1:10]
t = open("config/nginx/thechilli.conf.template").read()
env = {}
for l in open(os.environ["ENV_FILE"]):
    l = l.rstrip("\n")
    if "=" in l and not l.lstrip().startswith("#"):
        k, v = l.split("=", 1); v = v.strip()
        env[k.strip()] = v[1:-1] if len(v) > 1 and v[0] == v[-1] and v[0] in "'\"" else v
for k in ("DOMAIN_SITE","DOMAIN_ADMIN","DOMAIN_PARTNER","DOMAIN_APP","DOMAIN_WAITER","DOMAIN_API","DOMAIN_ORDER","STACK_HTTP_PORT"):
    t = t.replace(f"@@{k}@@", env[k])
t = t.replace("@@ACME_WEBROOT@@", env.get("ACME_WEBROOT") or "/var/www/html")
t = (t.replace("@@UPSTREAM@@", up).replace("@@SSL_CERT_TOP@@", ct).replace("@@SSL_KEY_TOP@@", kt)
      .replace("@@SSL_CERT_SUB@@", cs).replace("@@SSL_KEY_SUB@@", ks).replace("@@PUBLIC_PORT_SUFFIX@@", suf)
      .replace("@@EDGE_HEALTH@@", edge))
if hostvar != "$host":
    t = t.replace("proxy_set_header Host $host;", f"proxy_set_header Host {hostvar};").replace("proxy_set_header X-Forwarded-Host $host;", f"proxy_set_header X-Forwarded-Host {hostvar};")
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
open(out, "w").write(t)
PY
}
export ENV_FILE
# ACME webroot for port-80 renewals: .env ACME_WEBROOT, else certbot's own renewal config of the certificate, else /var/www/html
if [ -z "$(envget ACME_WEBROOT)" ] && [ "$MODE" = behind-nginx ]; then
  cname=$(basename "$(dirname "$(envget SSL_CERT_TOP)")")
  rc="/etc/letsencrypt/renewal/$cname.conf"
  wr=$( { cat "$rc" 2>/dev/null || sudo -n cat "$rc" 2>/dev/null; } | sed -n 's/^[[:space:]]*webroot_path[[:space:]]*=[[:space:]]*\([^,]*\).*/\1/p' | head -1)
  [ -n "$wr" ] || wr=$( { cat "$rc" 2>/dev/null || sudo -n cat "$rc" 2>/dev/null; } | sed -n '/\[\[webroot_map\]\]/,$s/^[^=]*=[[:space:]]*\(\/[^ ]*\)/\1/p' | head -1)
  if [ -n "$wr" ]; then envset ACME_WEBROOT "$wr"; ok "ACME webroot from $rc: $wr"
  else warn "could not read $rc (permission or not certbot --webroot): ACME_WEBROOT=/var/www/html; set ACME_WEBROOT in .env if renewals use another webroot"; fi
fi
P=$(envget STACK_HTTP_PORT)
render_nginx config/nginx/thechilli.conf "127.0.0.1:$P" "$(envget SSL_CERT_TOP)" "$(envget SSL_KEY_TOP)" "$(envget SSL_CERT_SUB)" "$(envget SSL_KEY_SUB)" "" "" '$host'
ok "config/nginx/thechilli.conf rendered (upstream 127.0.0.1:$P)"
if [ "$MODE" = local-test ]; then
  mkdir -p nginx/localtest/certs
  if [ ! -f nginx/localtest/certs/local.crt ]; then
    san="DNS:$(envget DOMAIN_SITE),DNS:$(envget DOMAIN_ADMIN),DNS:$(envget DOMAIN_PARTNER),DNS:$(envget DOMAIN_APP),DNS:$(envget DOMAIN_WAITER),DNS:$(envget DOMAIN_API),DNS:$(envget DOMAIN_ORDER)"
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$(envget DOMAIN_SITE)" -addext "subjectAltName=$san" \
      -keyout nginx/localtest/certs/local.key -out nginx/localtest/certs/local.crt >/dev/null 2>&1
    chmod 644 nginx/localtest/certs/local.key   # local throwaway test key; nginx worker must read it
  fi
  render_nginx nginx/localtest/thechilli.conf "caddy:80" /certs/local.crt /certs/local.key /certs/local.crt /certs/local.key \
    "$(envget PUBLIC_PORT_SUFFIX)" '    location = /__edge_health { access_log off; return 200 "ok\n"; }' '$http_host'
  ok "local edge nginx config rendered (self-signed certificate)"
fi

# =====================================================================================================================
if [ "$SKIP_BUILD" = 0 ]; then
  # no provenance attestation: an unchanged source then gives the SAME image id, so a re-run recreates nothing
  say "6/11 build images ONE AT A TIME (first build on 4 vCPU: about 25-45 min; later builds use the cache)"
  for s in $BUILD_ORDER; do
    t=$(date +%s); blog="$LOG_DIR/build-$s.log"; : > "$blog"
    say "  building $s (log: $blog)"
    built=0
    for attempt in 1 2 3; do   # package downloads (pypi, npm) can time out on a busy network: retry, the cache keeps finished layers
      if nice -n 15 env DOCKER_BUILDKIT=1 BUILDX_NO_DEFAULT_ATTESTATIONS=1 scripts/dc.sh build --progress plain "$s" >> "$blog" 2>&1; then built=1; break; fi
      [ "$attempt" = 3 ] || { warn "  $s build attempt $attempt failed ($(grep -m1 -oE 'network timeout|Failed to download[^`]*|ETIMEDOUT|ECONNRESET|ERROR: [^"]{0,80}' "$blog" | tail -1)); retrying in 20 s"; sleep 20; }
    done
    if [ "$built" = 1 ]; then ok "  $s built in $(( $(date +%s) - t ))s"
    else tail -30 "$blog"; die "build of $s failed 3 times (full log: $blog)"; fi
  done
  scripts/verify-images.sh || die "built images do not carry the configured hostnames (see above)"
else say "6/11 build skipped (--skip-build)"; fi

# =====================================================================================================================
say "7/11 database"
dc up -d --no-build db
wait_healthy 120 db || die "database did not become healthy (scripts/logs.sh db)"
ok "database healthy"

say "8/11 migrations (one-shot containers, each must exit 0)"
for m in $MIGRATIONS; do
  if dc run --rm --no-deps -T "$m" > "$LOG_DIR/migrate-$m.log" 2>&1; then ok "  $m"; else tail -30 "$LOG_DIR/migrate-$m.log"; die "$m failed (log: $LOG_DIR/migrate-$m.log)"; fi
done
for d in $DATABASES; do
  n=$(dc exec -T db psql -U chilli_admin -d "$d" -tAc "select count(*) from pg_tables where schemaname='public'" | tr -d '[:space:]')
  [ "${n:-0}" -gt 1 ] || die "database $d has no tables after its migration (exit 0 alone is not proof)"
  v=$(dc exec -T db psql -U chilli_admin -d "$d" -tAc "select version_num from alembic_version" 2>/dev/null | tr -d '[:space:]')
  ok "  $d: $n tables, alembic $v"
done

say "9/11 role split (RLS: the APIs log in as roles that own nothing)"
(cd "$COMPOSE_DIR" && DB_EXEC="$BUNDLE_DIR/scripts/dc.sh exec -T" scripts/rls-role-split.sh > "$LOG_DIR/rls-role-split.log" 2>&1) \
  || { tail -20 "$LOG_DIR/rls-role-split.log"; die "rls-role-split.sh failed"; }
own=$(dc exec -T db psql -U chilli_admin -d pos -tAc "select count(*) from pg_tables where schemaname='public' and tableowner='pos_app'" | tr -d '[:space:]')
[ "$own" = 0 ] || die "pos_app still owns $own tables after the role split"
ok "role split verified (pos_app owns 0 tables)"

# =====================================================================================================================
say "10/11 start everything"
if [ "$MODE" = behind-nginx ] || [ "$MODE" = local-test ]; then
  p=$(envget STACK_HTTP_PORT); ours_now=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Ports}}' | grep -c ":$p->" || true)
  [ "$ours_now" != 0 ] || ! port_busy "$p" || die "STACK_HTTP_PORT $p became busy: run scripts/deploy.sh again (it picks another)"
fi
scripts/validate-router.sh || die "fix Caddyfile first (nothing was started)"
dc up -d --no-build --remove-orphans
# the Caddyfile is a bind mount: compose does not recreate the router when only its content changed; reload is graceful
dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
wait_healthy 600 db pos-service platform-core marketing-service payments-service aggregator-service delivery-service \
  web-public web-super-admin web-marketing web-business-admin waiter-app caddy || { dc ps; die "some services are not healthy (scripts/status.sh, scripts/logs.sh <service>)"; }
ok "all services healthy"

say "11/11 plans + first data"
if [ -f plans.json ]; then scripts/seed-plans.sh --project "$PROJECT" --plans-file plans.json
elif [ "$PLACEHOLDER" = 1 ] || [ "$MODE" = local-test ]; then scripts/seed-plans.sh --project "$PROJECT" --accept-placeholder-prices
else
  plans=$(dc exec -T db psql -U chilli_admin -d platform -tAc "select count(*) from plans" 2>/dev/null | tr -d '[:space:]' || echo 0)
  if [ "${plans:-0}" = 0 ]; then warn "NO PLANS yet: put your plans in ./plans.json (format: src/platform-core/scripts/seed_catalog.py --help) or run scripts/deploy.sh --skip-build --accept-placeholder-prices (edit prices later in Super Admin). Nothing can be provisioned without plans."
  else ok "plans present ($plans)"; fi
fi
# platform-core <-> marketing read key: gen-env.sh creates both halves, nothing else to link on a fresh install.

sch=https; suf=$(envget PUBLIC_PORT_SUFFIX)
cat <<EOF

${c_bold}Deployed in $(( ($(date +%s) - T0) / 60 )) min.${c_off}  Project: $PROJECT   Router: 127.0.0.1:$(envget STACK_HTTP_PORT)
  Public site     $sch://$(envget DOMAIN_SITE)$suf
  Super Admin     $sch://$(envget DOMAIN_ADMIN)$suf
  Partner portal  $sch://$(envget DOMAIN_PARTNER)$suf
  Business app    $sch://$(envget DOMAIN_APP)$suf
  Waiter app      $sch://$(envget DOMAIN_WAITER)$suf
  API             $sch://$(envget DOMAIN_API)$suf/api/v1/health
  Order pages     $sch://$(envget DOMAIN_ORDER)$suf   (routed, not announced)
EOF
if [ "$MODE" = behind-nginx ]; then cat <<EOF

${c_bold}Next (by hand, once):${c_off}
  1. Host nginx (shared: reload, never restart):
       sudo cp $BUNDLE_DIR/nginx/thechilli.conf /etc/nginx/conf.d/thechilli.conf
       sudo nginx -t            # if it fails: sudo rm /etc/nginx/conf.d/thechilli.conf and do NOT reload
       sudo systemctl reload nginx
  2. scripts/create-super-admin.sh      (then sign in at https://$(envget DOMAIN_ADMIN) and enrol the authenticator app)
  3. scripts/create-marketing-admin.sh
  4. scripts/status.sh
EOF
fi
