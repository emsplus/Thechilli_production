#!/usr/bin/env bash
# Verify the built web images carry THIS .env's hostnames (NEXT_PUBLIC_* are baked at build time) and no development default.
# Runs each image offline (--network none, read-only) and greps its browser bundle. Exit 1 on any problem.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
set +e
api="$(envget DOMAIN_API)$(envget PUBLIC_PORT_SUFFIX)"; site="$(envget DOMAIN_SITE)$(envget PUBLIC_PORT_SUFFIX)"
bad=0
check() {  # SERVICE "must-contain..." ; forbids development defaults
  local svc=$1; shift; local img="${PROJECT}-${svc}" s
  docker image inspect "$img" >/dev/null 2>&1 || { warn "$svc: image $img not built"; bad=1; return; }
  for s in "$@"; do
    if docker run --rm --network none --read-only --entrypoint sh "$img" -c "grep -rqF '$s' /w/app/.next/static" ; then ok "$svc: browser bundle contains $s"
    else printf '%s[FAIL]%s %s: browser bundle does NOT contain %s\n' "$c_red" "$c_off" "$svc" "$s" >&2; bad=1; fi
  done
  leaks=$(docker run --rm --network none --read-only --entrypoint sh "$img" -c \
    "grep -rhoE 'https?://(localhost|127\.0\.0\.1|10\.0\.2\.2):[0-9]+/api/v1|https?://[a-z.]*chilli\.example[a-z/]*' /w/app/.next/static | sort -u" 2>/dev/null)
  if [ -n "$leaks" ]; then printf '%s[FAIL]%s %s: development defaults in the browser bundle: %s\n' "$c_red" "$c_off" "$svc" "$(echo $leaks)" >&2; bad=1
  else ok "$svc: no localhost / chilli.example API defaults"; fi
  if docker run --rm --network none --read-only --entrypoint sh "$img" -c "ls -a /w/app | grep -qE '^\.env'"; then
    printf '%s[FAIL]%s %s: a .env file is inside the image\n' "$c_red" "$c_off" "$svc" >&2; bad=1; fi
}
check web-business-admin "https://$api/api/v1" "https://$api/platform/api/v1"
check waiter-app "https://$api/api/v1" "https://$site/signup"
check web-public "https://$api/platform/api/v1" "https://$api/marketing/api/v1"
check web-marketing
check web-super-admin
exit $bad
