#!/usr/bin/env bash
# Start/restart the selfhost api on fxcompute-01 for the spike. Uses a pidfile (no pkill -f self-match).
cd ~/src/maple/apps/selfhost
[ -f /tmp/maple-api.pid ] && kill "$(cat /tmp/maple-api.pid)" 2>/dev/null; sleep 1
. ./spike.env.sh
nohup ~/.bun/bin/bun run src/api.ts > /tmp/maple-api.log 2>&1 &
echo $! > /tmp/maple-api.pid
for i in $(seq 90); do curl -fsS -m2 http://127.0.0.1:3472/health >/dev/null 2>&1 && break; sleep 1; done
echo "health: $(curl -s -m3 -w ' %{http_code}' http://127.0.0.1:3472/health) after ${i}s"
tail -12 /tmp/maple-api.log
