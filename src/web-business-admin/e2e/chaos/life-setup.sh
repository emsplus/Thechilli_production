#!/bin/bash
# Prepares two production builds (A = current source, B = a visibly changed source) of an app in a scratch copy, so a test can switch the
# server from build A to build B (old chunks 404). Usage: life-setup.sh <worktree> <scratch-dir> <marker-file> <old-string> <new-string>
set -euo pipefail
SRC=$1; DST=$2; FILE=$3; OLD=$4; NEW=$5
rm -rf "$DST"; mkdir -p "$DST"
rsync -a --exclude .next --exclude out --exclude test-results --exclude .git "$SRC"/ "$DST"/ >/dev/null
cp -cR "$SRC/node_modules" "$DST/node_modules" 2>/dev/null || true
# the design-system links point at the sibling worktrees: keep them valid from the copy (DST must live next to them, e.g. in _wt/)
for l in "$SRC"/node_modules/@chilli/*; do ln -sfn "$(readlink -f "$l")" "$DST/node_modules/@chilli/$(basename "$l")"; done
cd "$DST"
export NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:18931/api/v1
npx next build > build-A.log 2>&1; mv .next .nextA
python3 - "$FILE" "$OLD" "$NEW" <<'PY'
import sys
f,o,n=sys.argv[1:4]; s=open(f).read(); assert o in s, "marker not found"; open(f,'w').write(s.replace(o,n,1))
PY
npx next build > build-B.log 2>&1; mv .next .nextB
echo "built A and B in $DST"
