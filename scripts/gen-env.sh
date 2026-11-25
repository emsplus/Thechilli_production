#!/usr/bin/env bash
# Generate the random secrets of the stack into the bundle's single .env. Never changes a value that is already there.
#   scripts/gen-env.sh            create .env, or (when it exists) append the variables that are missing
#   scripts/gen-env.sh --update   append only the variables missing from an existing .env (never changes existing values)
#   scripts/gen-env.sh --rescope  rewrite ONLY PLATFORM_SERVICE_KEYS of an existing .env from its raw keys (picks up the scope list below,
#                           e.g. the billing.* scopes pos-service needs for PAYG metering); then recreate platform-core
# .env.secrets (owner-managed) is never read or written by this script.
set -euo pipefail
cd "$(dirname "$0")/.."   # the bundle root: .env, .env.secrets and docker-compose*.yml live there
ENVF=${ENV_FILE:-.env}   # local-test mode passes .env.localtest
mode=create
[ "${1:-}" = "--update" ] && mode=update
[ "${1:-}" = "--rescope" ] && mode=rescope
if [ "$mode" = create ] && [ -e "$ENVF" ]; then mode=update   # the one .env of the bundle already exists (user settings): only append what is missing
elif [ "$mode" = create ]; then :
else
  [ -e "$ENVF" ] || { echo "no $ENVF to update" >&2; exit 1; }
fi
envval() { sed -n "s/^$1=//p" "$ENVF" | head -1; }
# platform-core RS256 keyring as single-line JSON (same shape as platform-core/scripts/gen_keyring.py)
keyring() {
  local pem; pem=$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)
  PEM="$pem" python3 -c 'import json,os,secrets;k="k-"+secrets.token_hex(4);print(json.dumps({"active_kid":k,"keys":[{"kid":k,"private_pem":os.environ["PEM"]}]},separators=(",",":")))'
}
rnd() { openssl rand -hex "${1:-24}"; }
sha() { printf %s "$1" | openssl dgst -sha256 | awk '{print $NF}'; }
umask 077
MKT_KEY=$(rnd 32)
POS_KEY=$(rnd 32)
PROVISION_KEY=$(rnd 32)   # platform-core -> pos-service /internal/provision (raw key here, only its sha256 on the pos side)
MKT_READ_KEY=$(rnd 32)    # platform-core -> marketing-service read-only views (raw key here, only its sha256 in MARKETING_SERVICE_KEYS)
if [ "$mode" = rescope ]; then
  MKT_KEY=$(envval MARKETING_SERVICE_KEY); POS_KEY=$(envval POS_PLATFORM_SERVICE_KEY)
  [ -n "$MKT_KEY" ] && [ -n "$POS_KEY" ] || { echo ".env has no MARKETING_SERVICE_KEY / POS_PLATFORM_SERVICE_KEY to derive from" >&2; exit 1; }
fi
# platform-core SERVICE_KEYS: JSON name -> {key_sha256, scopes}. Only hashes are stored here; raw keys are the *_SERVICE_KEY vars.
# pos-service scopes (docs/PAYG_BILLING.md 7.6): entitlements.read (feature gating), billing.usage.write (one usage event per bill),
# billing.read (wallet block shown in business-admin), billing.topup (top-up intents), support_access.verify (support sessions).
# Without the billing.* scopes metering is silently rejected (403) and PAYG never charges.
SERVICE_KEYS=$(MKT_HASH=$(sha "$MKT_KEY") POS_HASH=$(sha "$POS_KEY") python3 -c 'import json,os;print(json.dumps({
 "marketing-service":{"key_sha256":os.environ["MKT_HASH"],"scopes":["onboarding.submit","onboarding.read","subscriptions.read"]},
 "pos-service":{"key_sha256":os.environ["POS_HASH"],"scopes":["entitlements.read","billing.read","billing.usage.write","billing.topup","support_access.verify"]}},separators=(",",":")))')
if [ "$mode" = rescope ]; then
  tmp=$(mktemp); grep -v '^PLATFORM_SERVICE_KEYS=' "$ENVF" > "$tmp" || true
  printf "PLATFORM_SERVICE_KEYS='%s'\n" "$SERVICE_KEYS" >> "$tmp"; cat "$tmp" > "$ENVF"; rm -f "$tmp"
  echo "PLATFORM_SERVICE_KEYS rewritten (pos-service: entitlements.read billing.read billing.usage.write billing.topup support_access.verify)."
  echo "Apply it: docker compose -p \"\${COMPOSE_PROJECT_NAME:-chilli-local}\" up -d platform-core"
  exit 0
fi
# marketing-service SERVICE_KEYS (security review finding 5): platform-core reads 4 views with scope marketing.read only.
MARKETING_SERVICE_KEYS=$(READ_HASH=$(sha "$MKT_READ_KEY") python3 -c 'import json,os;print(json.dumps({
 "platform-core":{"key_sha256":os.environ["READ_HASH"],"scopes":["marketing.read"]}},separators=(",",":")))')
out=$(mktemp)
trap 'rm -f "$out"' EXIT
cat > "$out" <<ENV
COMPOSE_PROJECT_NAME=chilli-local
POSTGRES_PASSWORD=$(rnd)
POS_DB_PASSWORD=$(rnd)
PAYMENTS_DB_PASSWORD=$(rnd)
MARKETING_DB_PASSWORD=$(rnd)
AGGREGATOR_DB_PASSWORD=$(rnd)
PLATFORM_DB_PASSWORD=$(rnd)
DELIVERY_DB_PASSWORD=$(rnd)
POS_MIGRATOR_DB_PASSWORD=$(rnd)
DELIVERY_MIGRATOR_DB_PASSWORD=$(rnd)
POS_JWT_SECRET=$(rnd 32)
MARKETING_JWT_SECRET=$(rnd 32)
PAYMENTS_JWT_SECRET=$(rnd 32)
DELIVERY_LINK_SECRET=$(rnd 32)
PLATFORM_JWT_KEYRING='$(keyring)'
MARKETING_SERVICE_KEY=$MKT_KEY
POS_PLATFORM_SERVICE_KEY=$POS_KEY
PLATFORM_SERVICE_KEYS='$SERVICE_KEYS'
POS_PROVISION_KEY=$PROVISION_KEY
PLATFORM_MARKETING_READ_KEY=$MKT_READ_KEY
MARKETING_SERVICE_KEYS='$MARKETING_SERVICE_KEYS'
POS_PROVISION_KEY_SHA256=$(sha "$PROVISION_KEY")
DELIVERY_TOKEN_SECRET=$(rnd 32)
AGGREGATOR_ADMIN_API_KEY=$(rnd)
# Reverse proxies whose forwarded headers are trusted. No wildcard. Empty / 127.0.0.1 = trust none (no proxy in compose).
TRUSTED_PROXIES=
FORWARDED_ALLOW_IPS=127.0.0.1
# Optional: real sandbox provider keys (leave empty for local)
RZP_KEY_ID=
RZP_KEY_SECRET=
RZP_WEBHOOK_SECRET=
ENV
if [ "$mode" = create ]; then
  cp "$out" "$ENVF"
  echo "wrote $ENVF (git-ignored)"
  scripts/check-config.sh || echo "(not fatal here, but fix the items above before the first Provision)" >&2
else
  n=0
  while IFS= read -r line; do
    k=${line%%=*}
    case "$line" in \#*|"") continue;; esac
    if ! grep -q "^$k=" "$ENVF"; then printf '%s\n' "$line" >> "$ENVF"; echo "added $k"; n=$((n+1)); fi
  done < "$out"
  echo "appended $n variable(s) to $ENVF"
fi
