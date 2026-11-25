#!/bin/bash
# Usage: life-server.sh <dir> <A|B> <port>  : makes .next = build A or B and (re)starts `next start` on the port.
set -e
cd "$1"; pkill -f "next start -p $3" 2>/dev/null || true; sleep 1
rm -rf .next; cp -cR ".next$2" .next
nohup env POS_API_URL=http://127.0.0.1:18931/api/v1 npx next start -p "$3" > "server-$3.log" 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$3/" && break; sleep 1; done
echo "serving build $2 on $3"
