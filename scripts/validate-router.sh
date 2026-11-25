#!/usr/bin/env bash
# Validate src/infra/compose/Caddyfile with the router's own pinned caddy image BEFORE it is (re)loaded:
#   scripts/validate-router.sh            exit 0 = valid
# Runs a throwaway container with no network, read-only, no published ports; the running router is not touched.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
img=$(sed -n 's/^ *image: *\(caddy:[^ ]*\).*/\1/p' "$COMPOSE_DIR/docker-compose.yml" | head -n1)
[ -n "$img" ] || die "no caddy image found in docker-compose.yml"
scheme=http; top=none; sub=none
if [ "$MODE" = own-tls ]; then scheme=https; top=$(envget TLS_MODE_TOP); sub=$(envget TLS_MODE_SUB); top=${top:-auto}; sub=${sub:-auto}; fi
args=(); for k in DOMAIN_SITE DOMAIN_ADMIN DOMAIN_PARTNER DOMAIN_APP DOMAIN_WAITER DOMAIN_API DOMAIN_ORDER; do
  v=$(envget "$k"); [ -n "$v" ] || die "$k is empty in $ENV_FILE"; args+=(-e "$k=$v"); done
out=$(docker run --rm --network none --read-only --tmpfs /tmp --tmpfs /data --tmpfs /config --cap-drop ALL --cap-add NET_BIND_SERVICE \
  -v "$COMPOSE_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" "${args[@]}" -e ROUTER_SCHEME="$scheme" -e TLS_MODE_TOP="$top" -e TLS_MODE_SUB="$sub" \
  -e ACME_EMAIL="$(envget ACME_EMAIL)" "$img" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) \
  || { printf '%s\n' "$out" | tail -15 >&2; die "Caddyfile is NOT valid (the running router was not changed)"; }
ok "Caddyfile valid ($img, mode $MODE)"
