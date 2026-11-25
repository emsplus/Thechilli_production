#!/usr/bin/env bash
# Pre-flight check of .env and .env.secrets. Run it before `docker compose up` (gen-env.sh runs it for you).
#   scripts/check-config.sh            prints every problem loudly, exits 1 if a REQUIRED setting is missing, 0 otherwise
# Required:
#   SMTP_FROM            sender of owner invites, receipts, reports. Without it the first Provision ends in `failed`
#                        ("owner invite email failed: SMTP_FROM is not configured"). Example: SMTP_FROM=Chilli Agent <no-reply@zonov.ai>
#   pos-service scopes   PLATFORM_SERVICE_KEYS must give pos-service billing.usage.write (+ billing.read, billing.topup): otherwise
#                        PAYG metering is rejected with 403 and nothing is ever charged. Fix: scripts/gen-env.sh --rescope
# Warned only: SMTP_HOST (without it nothing leaves the stack: mail goes to mailpit or the log, per MAIL_POLICY).
# COMPOSE_ENV_FILE / COMPOSE_SECRETS_FILE override the two file names. Values from the caller's environment win over the files.
set -uo pipefail
cd "$(dirname "$0")/.."   # the bundle root: .env, .env.secrets and docker-compose*.yml live there
ENVF=${COMPOSE_ENV_FILE:-.env}; SECF=${COMPOSE_SECRETS_FILE:-.env.secrets}
val() { # NAME -> value from the environment, else .env.secrets, else .env (no shell evaluation, surrounding quotes stripped)
  local v; v=${!1:-}
  [ -n "$v" ] || for f in "$SECF" "$ENVF"; do [ -f "$f" ] && v=$(sed -n "s/^$1=//p" "$f" | head -1) && [ -n "$v" ] && break; done
  v=${v#\'}; v=${v%\'}; v=${v#\"}; v=${v%\"}; printf %s "$v"
}
bad=0
loud() { printf '\n*** %s\n' "$1" >&2; }
[ -f "$ENVF" ] || { loud "$ENVF is missing: run scripts/gen-env.sh"; bad=1; }
if [ -z "$(val SMTP_FROM)" ] && [ -z "$(val SMTP_USER)" ]; then
  loud "SMTP_FROM is NOT SET (also no SMTP_USER). Owner invites will fail and Provision ends in 'failed'.
    Put it in .env.secrets (git-ignored), e.g.:   SMTP_FROM=Chilli Agent <no-reply@zonov.ai>
    See docs/DEPLOYMENT.md (Email) and docs/OWNER_ACTIONS.md."
  bad=1
fi
[ -n "$(val SMTP_HOST)" ] || printf '\n(warning) SMTP_HOST is empty: no real mail leaves the stack (allowlisted/other recipients go to mailpit or the log).\n' >&2
keys=$(val PLATFORM_SERVICE_KEYS)
if [ -n "$keys" ]; then
  missing=$(KEYS="$keys" python3 -c '
import json,os,sys
try: k=json.loads(os.environ["KEYS"])
except Exception: print("unparseable JSON"); sys.exit()
have=set(k.get("pos-service",{}).get("scopes",[]))
print(" ".join(s for s in ("billing.usage.write","billing.read","billing.topup") if s not in have))' 2>/dev/null)
  if [ -n "$missing" ]; then
    loud "PLATFORM_SERVICE_KEYS: pos-service lacks scope(s): $missing. PAYG metering would be rejected (403) and never charge.
    Fix:  scripts/gen-env.sh --rescope   then recreate platform-core.  See docs/PAYG_BILLING.md 7.6."
    bad=1
  fi
fi
[ "$bad" = 0 ] && echo "config check ok" || echo "config check FAILED (see above)" >&2
exit "$bad"
