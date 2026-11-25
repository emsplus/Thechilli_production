#!/bin/sh
# Container entrypoint for the POS API.
#   serve    (default) run uvicorn. With MIGRATE_ON_START=1 it first runs migrations (single-replica setups only;
#            the production compose uses the one-shot `migrate` service instead).
#   migrate  run `alembic upgrade head` under a Postgres advisory lock (safe if started concurrently).
#   anything else is exec'd as-is, e.g. `alembic current` or `python -c ...`.
set -eu

cmd="${1:-serve}"
case "$cmd" in
  migrate)
    shift
    exec python /app/docker/migrate.py "$@"
    ;;
  serve)
    shift
    if [ "${MIGRATE_ON_START:-0}" = "1" ]; then
      python /app/docker/migrate.py
    fi
    # --forwarded-allow-ips: ONLY these peers (the reverse proxy's address or subnet) may set X-Forwarded-For / -Proto; for
    # any other peer the headers are ignored, so a client cannot spoof its IP (pairing / registration limits key on it).
    # Set FORWARDED_ALLOW_IPS to the proxy's IP list (comma separated). "*" trusts every peer and is refused outside ENV=development.
    # Unset = 127.0.0.1: proxy headers are then ignored for a proxy on another host, and the limits see the proxy as the client.
    fwd="${FORWARDED_ALLOW_IPS:-127.0.0.1}"
    if [ "$fwd" = "*" ] && [ "${ENV:-production}" != "development" ]; then
      echo "FORWARDED_ALLOW_IPS=* is not allowed outside ENV=development: list the reverse proxy's IP(s)/subnet instead" >&2
      exit 1
    fi
    exec uvicorn app.main:app \
      --host 0.0.0.0 --port "${PORT:-8000}" \
      --workers "${WEB_CONCURRENCY:-2}" \
      --proxy-headers --forwarded-allow-ips "$fwd" \
      --timeout-keep-alive "${UVICORN_KEEPALIVE_SECONDS:-75}" \
      --timeout-graceful-shutdown "${UVICORN_GRACEFUL_SECONDS:-20}" \
      --log-config "${UVICORN_LOG_CONFIG:-/app/docker/log-config.json}" \
      --no-server-header \
      "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
