#!/usr/bin/env bash
# Follow our logs:  scripts/logs.sh [service...]   (no service = all). Options pass through, e.g. scripts/logs.sh --since 1h pos-service
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
dc logs -f --tail 200 "$@"
