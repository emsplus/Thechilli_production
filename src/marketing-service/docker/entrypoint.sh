#!/bin/sh
set -e
case "${1:-serve}" in
  serve)   alembic upgrade head; exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8200}" ;;
  migrate) exec alembic upgrade head ;;
  *)       exec "$@" ;;
esac
