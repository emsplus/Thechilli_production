#!/usr/bin/env bash
# Validate the bundle's .env (it also holds the generated secrets once deploy.sh has run) BEFORE anything starts. One clear line per problem;
# exit 1 if any REQUIRED item is wrong. Run by deploy.sh; safe to run by hand any time:  ./scripts/check-env.sh [--local-test]
# shellcheck source=lib.sh
[ "${1:-}" = "--local-test" ] && export MODE=local-test
. "$(dirname "$0")/lib.sh"
set +e
bad=0
fail() { printf '%s[FAIL]%s %s\n' "$c_red" "$c_off" "$*" >&2; bad=1; }
note() { printf '%s[warn]%s %s\n' "$c_yel" "$c_off" "$*" >&2; }
v() { envget "$1"; }

[ -f "$ENV_FILE" ] || { fail "$ENV_FILE is missing: cp .env.example .env && chmod 600 .env, then fill the MUST lines"; exit 1; }
perm=$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")
[ "$perm" = 600 ] || note "$ENV_FILE has mode $perm: chmod 600 $ENV_FILE (it holds the SMTP password)"

# ---- hostnames
domains=""
for k in DOMAIN_SITE DOMAIN_ADMIN DOMAIN_PARTNER DOMAIN_APP DOMAIN_WAITER DOMAIN_API DOMAIN_ORDER; do
  d=$(v $k)
  if [ -z "$d" ]; then fail "$k is empty"; continue; fi
  printf '%s' "$d" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' || fail "$k='$d' is not a valid lower-case hostname"
  case "$d" in *example.com|*example.org|*chilli.example|*CHANGE*) fail "$k='$d' is a placeholder";; esac
  domains="$domains $d"
done
dups=$(printf '%s\n' $domains | sort | uniq -d)
[ -z "$dups" ] || fail "the same hostname is used twice: $dups"
suffix=$(v PUBLIC_PORT_SUFFIX)
if [ "$MODE" != local-test ]; then
  [ -z "$suffix" ] || fail "PUBLIC_PORT_SUFFIX='$suffix' must be empty in production (public URLs use 443)"
  case "$domains" in *localtest.me*|*localhost*) fail "localtest.me / localhost hostnames in a production .env";; esac
fi

# ---- network
for k in DEFAULT_SUBNET DEFAULT_IP_RANGE PROXY_IP POS_BFF_SUBNET POS_BFF_IP_RANGE POS_BFF_WEB_IP POS_BFF_PROXY_IP; do [ -n "$(v $k)" ] || fail "$k is empty"; done
python3 - "$(v DEFAULT_SUBNET)" "$(v PROXY_IP)" "$(v POS_BFF_SUBNET)" "$(v POS_BFF_WEB_IP)" "$(v POS_BFF_PROXY_IP)" "$(v DEFAULT_IP_RANGE)" "$(v POS_BFF_IP_RANGE)" <<'PY' || bad=1
import ipaddress, sys
try:
    dn, pip, bn, wip, bpip = sys.argv[1:6]
    d = ipaddress.ip_network(dn); b = ipaddress.ip_network(bn)
    errs = []
    if ipaddress.ip_address(pip) not in d: errs.append(f"PROXY_IP {pip} is not inside DEFAULT_SUBNET {dn}")
    for n, ip in (("POS_BFF_WEB_IP", wip), ("POS_BFF_PROXY_IP", bpip)):
        if ipaddress.ip_address(ip) not in b: errs.append(f"{n} {ip} is not inside POS_BFF_SUBNET {bn}")
    if wip == bpip: errs.append("POS_BFF_WEB_IP and POS_BFF_PROXY_IP must differ")
    if d.overlaps(b): errs.append("DEFAULT_SUBNET and POS_BFF_SUBNET overlap")
    dr = ipaddress.ip_network(sys.argv[6]); br = ipaddress.ip_network(sys.argv[7])
    if not dr.subnet_of(d): errs.append("DEFAULT_IP_RANGE must be inside DEFAULT_SUBNET")
    if not br.subnet_of(b): errs.append("POS_BFF_IP_RANGE must be inside POS_BFF_SUBNET")
    if ipaddress.ip_address(pip) in dr: errs.append("PROXY_IP must be outside DEFAULT_IP_RANGE (Docker could hand it to another container)")
    for n, ip in (("POS_BFF_WEB_IP", wip), ("POS_BFF_PROXY_IP", bpip)):
        if ipaddress.ip_address(ip) in br: errs.append(f"{n} must be outside POS_BFF_IP_RANGE")
    for e in errs: print("\033[31m[FAIL]\033[0m " + e, file=sys.stderr)
    sys.exit(1 if errs else 0)
except ValueError as e:
    print(f"\033[31m[FAIL]\033[0m bad subnet/IP: {e}", file=sys.stderr); sys.exit(1)
PY
port=$(v STACK_HTTP_PORT)
case "$port" in ''|*[!0-9]*) fail "STACK_HTTP_PORT='$port' is not a port number";; esac
case " 22 80 443 " in *" $port "*) fail "STACK_HTTP_PORT=$port is reserved (22/80/443 belong to the host)";; esac

# ---- mail
from=$(v SMTP_FROM); host=$(v SMTP_HOST); policy=$(v MAIL_POLICY)
if [ -z "$from" ]; then fail "SMTP_FROM is empty: e.g. SMTP_FROM=\"Chilli Agent <no-reply@zonov.ai>\" (owner invites fail without it)"
else printf '%s' "$from" | grep -Eq '^([^<>]+ )?<?[^@<> ]+@[^@<> ]+\.[^@<> ]+>?$' || fail "SMTP_FROM='$from' is not 'Name <address>' or an address"
  case "$from" in *example.com*|*CHANGE*) fail "SMTP_FROM is a placeholder";; esac
fi
case "$policy" in real|allowlist|log|mailpit) ;; *) fail "MAIL_POLICY='$policy' must be real, allowlist, log or mailpit";; esac
if [ "$MODE" != local-test ] && [ "$policy" != log ]; then
  [ -n "$host" ] || fail "SMTP_HOST is empty: no mail can be sent (set the owner's SMTP server, or MAIL_POLICY=log to run without mail)"
  [ -n "$(v SMTP_USER)" ] || note "SMTP_USER is empty (fine only for an SMTP relay without login)"
  [ -n "$(v SMTP_PASSWORD)" ] || note "SMTP_PASSWORD is empty (fine only for an SMTP relay without login)"
fi
[ "$MODE" = local-test ] || [ "$policy" != mailpit ] || fail "MAIL_POLICY=mailpit is for --local-test only (there is no mail catcher in production)"
case "$(v SMTP_SECURITY)" in ssl|starttls|none|'') ;; *) fail "SMTP_SECURITY must be ssl, starttls or none";; esac

# ---- optional providers: all or nothing
rz="$(v RZP_KEY_ID)$(v RZP_KEY_SECRET)"
if [ -n "$rz" ] && { [ -z "$(v RZP_KEY_ID)" ] || [ -z "$(v RZP_KEY_SECRET)" ] || [ -z "$(v RZP_WEBHOOK_SECRET)" ]; }; then
  fail "Razorpay: set RZP_KEY_ID, RZP_KEY_SECRET and RZP_WEBHOOK_SECRET together (or leave all empty)"; fi
if [ -n "$(v GEMINI_API_KEY)" ] && [ -z "$(v GEMINI_MODEL)" ]; then fail "GEMINI_API_KEY is set but GEMINI_MODEL is empty"; fi
if [ "$(v WHATSAPP_PROVIDER)" = meta ]; then
  for k in WHATSAPP_PHONE_NUMBER_ID WHATSAPP_ACCESS_TOKEN WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN; do [ -n "$(v $k)" ] || fail "WHATSAPP_PROVIDER=meta needs $k"; done
fi
case "$(v AI_OCR_PROVIDER)" in ''|auto|gemini) ;; xai) [ -n "$(v XAI_API_KEY)$(v GROK_API_KEY)" ] || fail "AI_OCR_PROVIDER=xai needs XAI_API_KEY (or GROK_API_KEY)";; *) fail "AI_OCR_PROVIDER must be auto, gemini or xai";; esac
case "$(v AI_STT_PROVIDER)" in ''|auto|gemini) ;; whisper) [ -n "$(v OPENAI_API_KEY)" ] || fail "AI_STT_PROVIDER=whisper needs OPENAI_API_KEY";; *) fail "AI_STT_PROVIDER must be auto, gemini or whisper";; esac
case "$(v AI_TEXT_PROVIDER)" in ''|auto|gemini) ;; xai) [ -n "$(v XAI_API_KEY)$(v GROK_API_KEY)" ] || fail "AI_TEXT_PROVIDER=xai needs XAI_API_KEY (or GROK_API_KEY)";; *) fail "AI_TEXT_PROVIDER must be auto, gemini or xai";; esac
case "$(v WHISPER_LANGUAGE)" in ''|[a-z][a-z]) ;; *) fail "WHISPER_LANGUAGE must be empty or a 2-letter ISO code (hi, en)";; esac
for k in XAI_BASE_URL OPENAI_BASE_URL; do u=$(v $k); [ -z "$u" ] || case "$u" in https://*) ;; *) fail "$k must be an https:// URL";; esac; done
grep -nE '=(.*CHANGE_?ME.*|<[a-z ]+>)$' "$ENV_FILE" | sed 's/=.*//' | while read -r l; do printf '%s[FAIL]%s placeholder value left: %s\n' "$c_red" "$c_off" "$l" >&2; done
grep -qE '=(.*CHANGE_?ME.*|<[a-z ]+>)$' "$ENV_FILE" && bad=1

# ---- TLS certificate paths for the host nginx (they live on the host; may need sudo to read)
if [ "$MODE" = behind-nginx ]; then
  for k in SSL_CERT_SUB SSL_KEY_SUB SSL_CERT_TOP SSL_KEY_TOP; do
    p=$(v $k); [ -n "$p" ] || { fail "$k is empty (path of the certificate for config/nginx/thechilli.conf)"; continue; }
    if [ -e "$p" ] || sudo -n test -f "$p" 2>/dev/null; then :
    elif [ -r "$(dirname "$p")" ]; then note "$k=$p does not exist on this host: fix the path before installing config/nginx/thechilli.conf"
    else note "$k=$p: cannot verify (no permission to read $(dirname "$p")); 'sudo nginx -t' will check it"; fi
  done
fi

# ---- generated secrets (after deploy.sh has added them to the same .env)
CE="$ENV_FILE"
if [ -f "$CE" ]; then
  cperm=$(stat -c %a "$CE" 2>/dev/null || stat -f %Lp "$CE"); [ "$cperm" = 600 ] || fail "$CE has mode $cperm (must be 600)"
  for k in POSTGRES_PASSWORD POS_DB_PASSWORD PLATFORM_DB_PASSWORD MARKETING_DB_PASSWORD PAYMENTS_DB_PASSWORD AGGREGATOR_DB_PASSWORD \
           DELIVERY_DB_PASSWORD POS_MIGRATOR_DB_PASSWORD DELIVERY_MIGRATOR_DB_PASSWORD; do
    n=$(envget $k "$CE" | wc -c | tr -d ' '); [ "$n" -ge 24 ] || fail ".env $k is shorter than 24 characters"; done
  for k in POS_JWT_SECRET MARKETING_JWT_SECRET PAYMENTS_JWT_SECRET DELIVERY_LINK_SECRET DELIVERY_TOKEN_SECRET POS_PIN_PEPPER \
           AGGREGATOR_JWT_SECRET AGGREGATOR_INTERNAL_JWT_SECRET DELIVERY_WHATSAPP_APP_SECRET; do
    n=$(envget $k "$CE" | wc -c | tr -d ' ')
    [ "$n" = 0 ] && [ "${STRICT_GENERATED:-0}" = 0 ] && continue   # not generated yet: deploy.sh adds it in step 3
    [ "$n" -ge 32 ] || fail ".env $k is shorter than 32 characters"; done
  for k in POS_MFA_ENCRYPTION_KEY PLATFORM_MFA_ENCRYPTION_KEY; do
    [ -z "$(envget $k "$CE")" ] && [ "${STRICT_GENERATED:-0}" = 0 ] && continue
    envget $k "$CE" | python3 -c 'import base64,sys; s=sys.stdin.read().strip(); sys.exit(0 if len(base64.urlsafe_b64decode(s+"=="))==32 else 1)' 2>/dev/null \
      || fail ".env $k is not a Fernet key"; done
  [ -n "$(envget PLATFORM_JWT_KEYRING "$CE")" ] || fail ".env PLATFORM_JWT_KEYRING is empty"
fi
if [ -f "$BUNDLE_DIR/.env.secrets" ]; then
  sperm=$(stat -c %a "$BUNDLE_DIR/.env.secrets" 2>/dev/null || stat -f %Lp "$BUNDLE_DIR/.env.secrets")
  [ "$sperm" = 600 ] || fail ".env.secrets has mode $sperm (must be 600)"
fi

if [ "$bad" = 0 ]; then ok "env check passed ($ENV_FILE)"; else printf '%senv check FAILED%s: fix the lines above, then run scripts/deploy.sh again\n' "$c_red" "$c_off" >&2; fi
exit "$bad"
