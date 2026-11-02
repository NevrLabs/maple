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

## #2 — same-origin API / sync URLs (web)

**Files:** `apps/web/src/lib/services/common/api-base-url.ts`, `apps/web/src/lib/services/common/electric-sync-url.ts`

**Why:** the single-host deployment (`apps/selfhost/compose/`, BRIEF-v4) serves web, API and Electric sync from
one origin behind Caddy (`/_api/*`, `/_sync/*`) and is reached on two hostnames (`monitoring.home`,
`monitoring.entelechia.cloud`). Upstream bakes absolute URLs at build time, so one image could serve only one host.

**Change:** a `sameOrigin()` helper: when `VITE_API_BASE_URL` / `VITE_ELECTRIC_SYNC_URL` start with `/`, resolve them
against `location.origin` at runtime. Absolute values behave exactly as upstream. Opt-in by build env only.

**Verify after rebase:** both files still export the same names; build with `/_api` + `/_sync` and grep the bundle for
`sameOrigin`; browser E2E `verify/e2e-monitoring.ts` on both hostnames.

## #3 — `/infra/proxmox` Infrastructure page (web)

**Why:** the self-hosted cluster is Proxmox VE (3 nodes, ~30 guests). PVE pushes native OpenTelemetry metrics
(`service.name = proxmox-ve`), but upstream has no page for them; the user wanted it "in infra/proxmox just like the
k8s". The page itself is fork-only (`apps/web/src/page/infra-integrations/proxmox/`); these upstream files only
register it.

**Data:** no new backend. Every read goes through the existing `executeRawSql` query-engine endpoint (the dashboard
widgets' path: `$__orgFilter`, validator, row limits). Backups/jobs/storage types are not in PVE's OTel stream; the
selfhost collector (`apps/selfhost/compose/proxmox-backups.py`, cron in CT130, read-only `PVEAuditor` token) writes
them to `maple.proxmox_backups` / `proxmox_backup_jobs` / `proxmox_storage` (DDL `clickhouse/proxmox.sql`).

**Upstream files touched (registration only, each a one-line list entry unless noted):**
- `apps/web/src/shell/nav.ts` — `NavSurface` gains `"proxmox"`; Infrastructure sub-item *Proxmox* after Kubernetes.
- `apps/web/src/data/infra-surfaces.ts` — `INTEGRATION_IDS` / `PENDING_INTEGRATIONS` gain `proxmox`.
- `apps/web/src/shell/message.ts`, `shell/model.ts` — `Integration` literal + `Integrations` flag `proxmox`.
- `apps/web/src/shell/data.ts` — `LoadProxmoxStatus` (raw-SQL presence: one PVE node sample in the last hour);
  `shell/update.ts` sends it with the other integration statuses. So the nav row appears only where PVE reports.
- `apps/web/src/route/search.ts` (`InfraProxmoxSearch`), `route/app-route.ts`, `route/routers.ts` (route + match
  order before the catch-alls), `page/registry.ts` (page).
- `apps/web/src/shell/shell.scene.test.ts` — the expected integration-status command lists include
  `LoadProxmoxStatus`.
- `apps/web/src/page/infra/overview/state.ts` — `NOT_CONNECTED` gains `proxmox: false` (type completeness only;
  the overview tiles are unchanged). Test fixtures `overview.scene.test.ts`, `workloads.scene.test.ts` likewise.

**Not upstream:** `apps/web/src/lab/proxmox-lab/*` (fork lab) now renders the shared `view-parts.ts`; its floating
state toolbar is lab-only and never ships in the route.

**Verify after rebase:** `bunx tsrs --noEmit`; `vitest run src/page/infra-integrations/proxmox src/shell src/lab`;
browser E2E `verify/e2e-proxmox-route.ts` against https://monitoring.home (sidebar row, 3 nodes, guest count =
`pvesh get /cluster/resources --type vm`, Storage + Backups tabs, 0 page errors).
