# Upstream files modified by the NevrLabs selfhost fork

Keep this list minimal; every entry is a rebase conflict risk.

## 1. `packages/backend/src/services/warehouse/WarehouseQueryService.ts` — internal writes to ClickHouse

**Why:** upstream hard-routes every internal warehouse write (`purpose: "ingest"`) to Tinybird's
Events API, and the ClickHouse client's `insert` always fails ("ClickHouse is read-only for Maple").
Self-hosted there is no Tinybird, so `alert_checks` (alert-rule check history / charts in
notifications), service-map rollups and the audit log were silently dropped
(`WarehouseUpstreamError: Tinybird HTTP transport failed`).

**What:** opt-in only. When `CLICKHOUSE_PROVIDER=clickhouse`, `CLICKHOUSE_URL` is set **and**
`CLICKHOUSE_WRITE_USER` (+ `CLICKHOUSE_WRITE_PASSWORD`) is set, `resolveRoute(…, "ingest")` returns a
`kind: "clickhouse"` config with the write credential, and the ClickHouse client's `insert` POSTs
`INSERT INTO <db>.<table> FORMAT JSONEachRow`. Without `CLICKHOUSE_WRITE_USER` behaviour is byte-for-byte
upstream. Reads still use the SELECT-only runtime user.

**Verify after rebase:** `bun run --cwd packages/backend typecheck`; alert rule `/v2/alerts/rules/:id/checks`
returns 200 with rows; `SELECT count() FROM maple.alert_checks` grows each minute.
