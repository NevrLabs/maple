#!/usr/bin/env bash
cd ~/src/maple/apps/selfhost
[ -f /tmp/maple-alerting.pid ] && kill "$(cat /tmp/maple-alerting.pid)" 2>/dev/null; sleep 1
. ./spike.env.sh
export PORT=3480 MAPLE_ALERTING_ALLOW_NONPROD=1
nohup ~/.bun/bin/bun run src/alerting.ts > /tmp/maple-alerting.log 2>&1 &
echo $! > /tmp/maple-alerting.pid
for i in $(seq 30); do curl -fsS -m2 http://127.0.0.1:3480/health >/dev/null 2>&1 && break; sleep 1; done
curl -s -X POST "http://127.0.0.1:3480/fire?cron=*%20*%20*%20*%20*"; echo
sleep 25
curl -s http://127.0.0.1:3480/health | python3 -m json.tool
grep -i -E "error|failed" /tmp/maple-alerting.log | head -8 | cut -c1-300
