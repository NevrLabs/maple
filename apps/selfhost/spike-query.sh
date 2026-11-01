#!/usr/bin/env bash
# Spike gate 3: a row written to ClickHouse comes back through the api's authenticated query path.
A=http://127.0.0.1:3472; CH="http://127.0.0.1:58123/"
T=$(curl -s -X POST $A/api/auth/login -H 'content-type: application/json' -d '{"password":"spike-root-password"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
cat > /tmp/ins.sql <<'SQL'
INSERT INTO default.traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, ServiceName, SpanName, SpanKind, Duration, StatusCode, ResourceAttributes, SpanAttributes)
VALUES ('default', now64(9), 'aaaabbbbccccdddd0000111122223333', '1111222233334444', '', 'spike-svc', 'GET /spike', 'Server', 12000000, 'Ok', map('deployment.environment','selfhost'), map('http.method','GET'))
SQL
echo "insert: $(curl -s -w '%{http_code}' -u maple:spikech "$CH?async_insert=0" --data-binary @/tmp/ins.sql)"
sleep 2
echo "raw rows: $(curl -s -u maple:spikech "$CH" --data-binary "SELECT count() FROM default.traces WHERE ServiceName='spike-svc'")"
echo "mv rows (service_overview_spans): $(curl -s -u maple:spikech "$CH" --data-binary "SELECT count() FROM default.service_overview_spans WHERE ServiceName='spike-svc'" 2>&1 | head -c 120)"
S=$(date -u -d '-1 hour' '+%Y-%m-%d %H:%M:%S'); E=$(date -u -d '+5 min' '+%Y-%m-%d %H:%M:%S')
echo "api service-overview: $(curl -s -w ' HTTP %{http_code}' -X POST $A/internal/query-engine/service-overview -H "authorization: Bearer $T" -H 'content-type: application/json' -d "{\"startTime\":\"$S\",\"endTime\":\"$E\"}" | cut -c1-400)"
