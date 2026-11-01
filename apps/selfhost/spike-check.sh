#!/usr/bin/env bash
# Spike gate checks against the selfhost api. Never prints tokens.
A=http://127.0.0.1:3472
code(){ curl -s -o /tmp/r.json -w '%{http_code}' "$@"; }
echo "1 health:           $(code $A/health)"
echo "2 wrong password:   $(code -X POST $A/api/auth/login -H 'content-type: application/json' -d '{"password":"nope"}') $(head -c 90 /tmp/r.json)"
C=$(code -X POST $A/api/auth/login -H 'content-type: application/json' -d '{"password":"spike-root-password"}')
TOKEN=$(python3 -c 'import json;print(json.load(open("/tmp/r.json")).get("token",""))' 2>/dev/null)
echo "3 root sign-in:     $C token_issued=$([ -n "$TOKEN" ] && echo yes len=${#TOKEN} || echo NO) keys=$(python3 -c 'import json;print(sorted(json.load(open("/tmp/r.json")).keys()))')"
H="authorization: Bearer $TOKEN"
echo "4 no-auth protected: $(code -X POST $A/internal/ai-sessions/list -H 'content-type: application/json' -d '{}')"
for p in /api/auth/session /api/org-clickhouse-settings /api/ingest-keys /api/alerts/rules /api/alerts/destinations; do
  echo "5 GET $p: $(code $A$p -H "$H") $(head -c 140 /tmp/r.json | tr '\n' ' ')"
done
