#!/usr/bin/env bash
# Environment settings for the two stacks that share one server (UAT = testing, Prod = real customers).
#
#   scripts/make-env.sh prod  > ~/Production/thechilli_resto/.env     a NEW stack: fresh .env from .env.example (own project, subnets, port)
#   scripts/make-env.sh uat   > .env.uat                   same for a new UAT stack
#   scripts/make-env.sh uat --patch .env                   an EXISTING stack: rewrite only its hostnames, certificate paths and mail
#                                                          policy in place (keeps every generated secret; the old file is saved as .env.bak-<time>)
#
# UAT hostnames all sit under *.testchilli.zonov.ai (one certificate covers them). UAT is project uat-thechilli, Prod is project
# production-thechilli. The old single stack was project 'chilli': its data volumes were copied to uat-thechilli_* when it became UAT
# (docs/ENVIRONMENTS.md). Prod has a new, empty database. The website is NOT part of either stack (deploy/site).
set -euo pipefail
cd "$(dirname "$0")/.."
env_name=${1:-}; mode=${2:-}; target=${3:-}
case "$env_name" in prod|uat) ;; *) echo "usage: scripts/make-env.sh prod|uat [--patch <existing .env>]" >&2; exit 2;; esac

UAT_ROOT=testchilli.zonov.ai
declare -a KEYS=()
set_kv() { KEYS+=("$1=$2"); }
if [ "$env_name" = uat ]; then
  set_kv COMPOSE_PROJECT_NAME uat-thechilli
  set_kv DOMAIN_SITE "site.$UAT_ROOT"; set_kv DOMAIN_ADMIN "admin.$UAT_ROOT"; set_kv DOMAIN_PARTNER "partner.$UAT_ROOT"
  set_kv DOMAIN_APP "app.$UAT_ROOT"; set_kv DOMAIN_WAITER "waiter.$UAT_ROOT"; set_kv DOMAIN_API "api.$UAT_ROOT"; set_kv DOMAIN_ORDER "order.$UAT_ROOT"
  cert=/etc/letsencrypt/live/$UAT_ROOT-wildcard   # one *.testchilli.zonov.ai certificate for every UAT name
  set_kv SSL_CERT_SUB "$cert/fullchain.pem"; set_kv SSL_KEY_SUB "$cert/privkey.pem"; set_kv SSL_CERT_TOP "$cert/fullchain.pem"; set_kv SSL_KEY_TOP "$cert/privkey.pem"
  set_kv MAIL_POLICY allowlist   # test data must never mail real customers
fi
# Prod keeps the hostnames and certificate lines of .env.example. A NEW prod stack also needs its own project, subnets and port.
NEW_PROD=(COMPOSE_PROJECT_NAME=production-thechilli STACK_HTTP_PORT=7090
          DEFAULT_SUBNET=10.231.92.0/24 DEFAULT_IP_RANGE=10.231.92.128/25 PROXY_IP=10.231.92.10
          POS_BFF_SUBNET=10.231.93.0/28 POS_BFF_IP_RANGE=10.231.93.0/29 POS_BFF_WEB_IP=10.231.93.10 POS_BFF_PROXY_IP=10.231.93.11)

apply() {  # FILE_IN, then KEY=VALUE args: replaces the line of each key (appends it when missing), prints the result
  local f=$1; shift; local kv k v out; out=$(cat "$f")
  for kv in "$@"; do
    k=${kv%%=*}; v=${kv#*=}
    if grep -q "^$k=" <<<"$out"; then out=$(K="$k" V="$v" python3 -c 'import os,sys,re; k,v=os.environ["K"],os.environ["V"]; print(re.sub(r"(?m)^"+re.escape(k)+r"=.*$", lambda m: k+"="+v, sys.stdin.read()), end="")' <<<"$out")
    else out="$out"$'\n'"$k=$v"; fi
  done
  printf '%s\n' "$out"
}

if [ "$mode" = --patch ]; then
  [ -f "$target" ] || { echo "no such file: $target" >&2; exit 2; }
  [ "$env_name" = uat ] || { echo "--patch is for the existing stack, which becomes UAT" >&2; exit 2; }
  cp -p "$target" "$target.bak-$(date +%Y%m%d%H%M%S)"
  apply "$target" "${KEYS[@]}" > "$target.new" && chmod --reference="$target" "$target.new" 2>/dev/null || chmod 600 "$target.new"
  mv "$target.new" "$target"; echo "patched $target for UAT (backup kept next to it)" >&2
elif [ -z "$mode" ]; then
  if [ "$env_name" = prod ]; then apply .env.example "${NEW_PROD[@]}"; else apply .env.example "${KEYS[@]}"; fi
else echo "unknown option $mode" >&2; exit 2; fi
