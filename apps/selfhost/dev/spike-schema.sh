#!/usr/bin/env bash
# Spike gate 2: ClickHouse settings → apply-schema (inline Workflow replacement) → status → tables.
A=http://127.0.0.1:3472
TOKEN=$(curl -s -X POST $A/api/auth/login -H 'content-type: application/json' -d '{"password":"spike-root-password"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
H="authorization: Bearer $TOKEN"; J='content-type: application/json'
S=$A/internal/org-clickhouse-settings
c(){ curl -s -o /tmp/r.json -w '%{http_code}' "$@"; }
# Docker host-gateway address of the CH container as seen from the api (both on host network loopback here).
echo "upsert:      $(c -X PUT $S/ -H "$H" -H "$J" -d '{"url":"http://127.0.0.1:58123","user":"maple","password":"spikech","database":"default"}') $(head -c 220 /tmp/r.json)"
echo "schema-diff: $(c $S/schema-diff -H "$H") $(python3 -c 'import json;d=json.load(open("/tmp/r.json"));print({k:(len(v) if isinstance(v,list) else v) for k,v in d.items()})' 2>/dev/null || head -c 200 /tmp/r.json)"
echo "apply:       $(c -X POST $S/apply-schema -H "$H" -H "$J" -d '{}') $(head -c 200 /tmp/r.json)"
for i in $(seq 60); do
  c $S/apply-schema/status -H "$H" >/dev/null
  st=$(python3 -c 'import json;d=json.load(open("/tmp/r.json"));r=d.get("run") or d;print(r.get("status"),r.get("phase"),r.get("errorMessage"))' 2>/dev/null)
  case "$st" in completed*|succeeded*|failed*|success*) break;; esac; sleep 5
done
echo "status:      $st (after ~$((i*5))s)"
echo "tables:      $(curl -s -u maple:spikech 'http://127.0.0.1:58123/?query=SELECT+countIf(engine+NOT+LIKE+%27%25View%27),countIf(engine=%27MaterializedView%27)+FROM+system.tables+WHERE+database=%27default%27')"
echo "migrations:  $(curl -s -u maple:spikech 'http://127.0.0.1:58123/?query=SELECT+count(),max(version)+FROM+default._maple_schema_migrations')"
