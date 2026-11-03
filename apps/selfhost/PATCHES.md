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
- `apps/web/src/view.lazy.test.ts` — sample path `/infra/proxmox` (every registered page needs one).
- `apps/web/src/shell/shell.scene.test.ts` — the expected integration-status command lists include
  `LoadProxmoxStatus`.
- `apps/web/src/page/infra/overview/state.ts` — `NOT_CONNECTED` gains `proxmox: false` (type completeness only;
  the overview tiles are unchanged). Test fixtures `overview.scene.test.ts`, `workloads.scene.test.ts` likewise.

**Not upstream:** `apps/web/src/lab/proxmox-lab/*` (fork lab) now renders the shared `view-parts.ts`; its floating
state toolbar is lab-only and never ships in the route.

**Verify after rebase:** `bunx tsrs --noEmit`; `vitest run src/page/infra-integrations/proxmox src/shell src/lab`;
browser E2E `verify/e2e-proxmox-route.ts` against https://monitoring.home (sidebar row, 3 nodes, guest count =
`pvesh get /cluster/resources --type vm`, Storage + Backups tabs, 0 page errors).

## #4 — "Sign in with Zitadel" (OIDC) beside the root password

**Why:** the operator signs in with the cluster's Zitadel (https://auth.entelechia.cloud) instead of sharing the root
password; the root password stays as break-glass. Upstream auth is `clerk | self_hosted` only.

**Shape:** not a third auth mode. The selfhost Bun server (`apps/selfhost/src/api.ts`, fork-only) answers
`/api/auth/oidc/{config,start,callback}` before the unmodified route graph (`apps/selfhost/src/oidc.ts`, fork-only):
code flow + PKCE S256 + state + nonce in a signed, HttpOnly, 10-min cookie; client_secret_basic code exchange; ID token
verified (RS256 via JWKS, iss, aud/azp, exp, nonce); **fails closed** unless the token carries project role
`MAPLE_OIDC_REQUIRED_ROLE` in `urn:zitadel:iam:org:project:roles`. Then it mints the SAME self-hosted session token the
root login issues (same signer, lifetimes, `root` role), subject `oidc:<zitadel sub>`, and hands it to the web in the
URL fragment (`/#maple_session=…`: never sent to a server or logged; boot moves it to session storage and wipes it). Sign-ins are logged `[oidc] sign-in ok
sub=… email=…`. Off unless `MAPLE_OIDC_ISSUER` + `MAPLE_OIDC_CLIENT_ID` + `MAPLE_OIDC_CLIENT_SECRET` are set.

**Upstream files touched:**
- `packages/auth/src/index.ts` — new export `makeMintSelfHostedSessionForSubject` (reuses `mintSelfHostedSessionToken`;
  nothing existing changes).
- `apps/web/src/platform/auth-api.ts` — `adoptOidcSessionFromUrl` (fragment -> session storage, fragment wiped).
- `apps/web/src/main.ts` — runs it before the stored-session flag is read; sign-in init gets the callback's refusal.
- `apps/web/src/update.ts` — same for entering `/sign-in`.
- `apps/web/src/route/search.ts` — `SignInSearch.oidc_error`.
- `apps/web/src/lib/services/common/auth-mode.ts` — `oidcProvider` from build flag `VITE_MAPLE_OIDC=zitadel`.
- `apps/web/src/page/sign-in/{sign-in,index,view}.ts` — `oidcError` in the model; button + divider above the form.
- `apps/web/src/page/sign-in/sign-in-oidc.scene.test.ts` (new).

**Zitadel side:** project `Maple` (roles asserted + checked on authentication), role `maple-admin`, WEB app (code,
basic), redirects `https://monitoring.{home,entelechia.cloud}/_api/api/auth/oidc/callback`. Client id/secret only in
the CT `.env`.

**Verify after rebase:** `bun test apps/selfhost/src/oidc.test.ts`; `vitest run src/page/sign-in`; `tsrs --noEmit`
(web, packages/auth); E2E `verify/e2e-zitadel-login.ts` (full code flow with a disposable user; role-less user refused).

## #5 — IdP-agnostic OIDC, users table, viewer role, instant revoke (BRIEF-users)

**Why:** Clerk replacement for self-host: the homelab signs in with Zitadel, Noovoleum will use Authentik; people need
a read-only role and an admin needs to cut someone off without waiting for the 12 h / 7 d session cap.

**Server (fork-only, apps/selfhost/src):**
- `oidc.ts` — any OIDC provider via discovery. Env: `MAPLE_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET` (on), plus
  `MAPLE_OIDC_ROLES_CLAIM` (dotted path; default Zitadel project roles), `MAPLE_OIDC_SCOPES`, `MAPLE_OIDC_ADMIN_ROLE`
  (`maple-admin`; legacy `MAPLE_OIDC_REQUIRED_ROLE`), `MAPLE_OIDC_VIEWER_ROLE` (`maple-viewer`), `MAPLE_OIDC_LABEL`,
  `MAPLE_OIDC_HOSTS`. Claim may be an object keyed by role, an array (Authentik `groups`) or a string; admin wins;
  neither = refused. RS256 + ES256.
  Authentik example: `ROLES_CLAIM=groups SCOPES="openid profile email groups" ADMIN_ROLE="Maple Admins"
  VIEWER_ROLE="Maple Viewers" LABEL="Noovoleum SSO"` (+ the build flag `VITE_MAPLE_OIDC="Noovoleum SSO"`).
- `session.ts` — mints/reads the SAME HS256 self-hosted session the API verifies. admin -> role `root`, viewer ->
  `org:member` (non-admin to every upstream `isAdmin` check); display claims `name/email/idp` the API ignores.
- `users.ts` — Postgres `selfhost_users` (created on api start; not in upstream migrations): sub PK, email, name, idp,
  role, first_seen, last_seen, disabled, sessions_valid_after. Upsert per sign-in; 5 s read cache, invalidated by writes.
- `gate.ts` — in front of the graph (api AND electric-sync): `oidc:*` token disabled or `iat <= sessions_valid_after`
  -> 401 `session_revoked`; viewer non-GET -> 403 `read_only_role` unless the ROUTE is an allowlisted read
  (`route-policy.ts`, matched against `route-table.generated.ts` = every endpoint reflected from MapleApi /
  MapleInternalApi / MapleApiV2 / MapleAiApi; regenerate with `bun src/gen-route-table.ts` after a rebase —
  `gate.test.ts` fails if an allowlisted id disappears). OIDC session renewal is answered by the gate so the renewed
  token keeps role + identity. Members API: `GET /api/selfhost/me`, `GET /api/selfhost/users`,
  `POST /api/selfhost/users/:sub/{disable,enable,sign-out}` (admin; root row fixed; no self-disable).
- `packages/auth` is back to upstream (the #4 mint export was removed; minting lives in session.ts).

**Web (upstream files touched):** `page/settings/{model,message,update,view,nav}.ts` (Members tab = `selfhost-members/`
when not Clerk; viewer = non-admin), `page/settings/selfhost-members/*` (new), `platform/selfhost-session.ts` (new:
identity from the token), `platform/auth-api.ts` (`readSessionTokenSync`), `platform/api-clients.ts` (a 401 drops the
tab session -> /sign-in), `shell/view-sidebar.ts` + `shell/view-menus.ts` (chip/menu show the OIDC name + role),
`page/dashboards/list/view.ts` + `page/alerts/hub/view.ts` (viewer: Create/Import/New rule hidden),
`lib/services/common/auth-mode.ts` + `page/sign-in/view.ts` (button label = `VITE_MAPLE_OIDC`).

**Verify after rebase:** `bun test apps/selfhost/src/{oidc,gate}.test.ts`; `vitest run src/page/settings src/page/sign-in`;
E2E `verify/e2e-users.ts` (Zitadel disposable admin + viewer).

## #6 — durable VCS-sync queue (BRIEF-integrations A2)

Upstream runs GitHub webhook/backfill work on a Cloudflare Queue; selfhost `ports.ts` had `droppingQueue("vcs-sync")`,
so every webhook delivery was acknowledged and then thrown away.

- `vcs-queue.ts` (new) — Postgres table `selfhost_vcs_queue` (created on api start; not in upstream migrations).
  Producer = INSERT; consumer = in-process loop in the api: `FOR UPDATE SKIP LOCKED`, 300 s lease, batch 10, feeds
  the UNMODIFIED upstream `processBatch` (`apps/api/src/vcs-sync-runtime.ts`). ack -> DELETE; retry/throw -> backoff
  10 s, 40 s, 90 s … capped 15 min (never dropped). Also fires upstream's 12 h scheduled sync.
- `ports.ts` — `selfhostPorts(env, vcsSync?)`: the queue producer is injected; the dropping stub remains only as the
  fallback when no PG URL is set.
- `api.ts` — builds the store, `ensureSchema`, passes the producer to the ports, starts the consumer after listen
  (logs `[vcs-queue] on` / `[vcs-queue] off`).

**Verify after rebase:** `bun test apps/selfhost/src/vcs-queue.test.ts`; api log shows `[vcs-queue] on`;
`\d selfhost_vcs_queue` exists in PG.

## #7 — collector processors (BRIEF-integrations D: RES-01 / LOG-04)

`otel/builder-config.yaml` adds `resourceprocessor` and `transformprocessor` (v0.151.0) so the central collector can
normalise every sender: `transform/service-name` (fallback `service.name` from resource keys) and
`transform/severity` (map numeric / empty / non-standard severities to the standard levels). Config lives in
`apps/selfhost/compose/otel-collector.yaml`. **Verify after rebase:** collector image builds; `validate --config`.

## #8 — uptime prober on the LAN (BRIEF-uptime 1)

Upstream runs `apps/scraper` (uptime HTTP/TCP/DNS checks) on its own infra and refuses every private target
(SSRF guard). Self-hosted, the whole point is probing the homelab.

- `lib/safe-fetch/src/index.ts` — **upstream file**. `MAPLE_SELFHOST_PRIVATE_NETWORKS` (comma list of IPv4 CIDRs +
  DNS suffixes, e.g. `192.168.0.0/16,home`): hosts/addresses inside it are not "private" for `parseExternalUrl`,
  `isPrivateAddress` and the pinned guard. Loopback, `169.254/16` (metadata) and `0/8` stay refused even if listed.
  Unset (every upstream deployment, every Worker: no `process.env`) = byte-for-byte upstream behaviour.
  Applies to the api (monitor validation) and the scraper (probe + DNS pinning).
- `apps/scraper/src/UptimeSpans.ts` — **upstream file**. `MAPLE_SELFHOST_UPTIME_TARGET_SPANS=1`: a monitor with a
  `service_name` also exports one SERVER span per check under that service (child of the `maple-uptime` check span,
  same trace, attribute `maple.uptime.synthetic=true`), so every monitored target is listed on Services next to its
  metrics/logs. The check span is unchanged, so the uptime UI/queries are unaffected. Off = upstream.
- `apps/selfhost/dev/build-images.sh` bundles `apps/scraper/src/main.ts` (unmodified entry) into `/app/scraper.js`;
  compose service `scraper` (`dns: 192.168.1.4` AdGuard, `NODE_EXTRA_CA_CERTS` = the CT101 `*.home` cert, so TLS is
  verified, not skipped).

**Verify after rebase:** `bun test lib/safe-fetch apps/scraper`; scraper `/health` 200; `SELECT count() FROM
maple.traces WHERE ServiceName='maple-uptime' AND Timestamp > now() - INTERVAL 10 MINUTE` > 0.

## #9 — status pages without Cloudflare (BRIEF-uptime 1)

Upstream publishes status pages into Workers KV + R2 (`StatusPageStore.fromBindings`) and serves them from the status
Worker; selfhost had `StatusPageStore.inMemory` in the api and no bindings in alerting, so nothing was published.

- `apps/selfhost/src/status-store.ts` (new) — Postgres table `selfhost_status_kv (ns kv|r2, key, value)`; KV/bucket
  shims matching `StatusPageKvNamespace`/`StatusPageBucket` (keyset-paginated `list`).
- `ports.ts` — `StatusPageStore.fromBindings(pg shims)` when `MAPLE_PG_URL` is set (in-memory otherwise).
- `alerting.ts` — passes the same bindings to `runScheduled`, so the escalation lane's `statusPages` tick
  (reconcile, auto incidents, publish sweep, heartbeat) runs.
- `status.ts` (new) — Bun server running `apps/status/src/handler.ts` **unmodified** over Postgres storage
  (colo cache = in-process map; break-glass limiter in memory). Caddy `/s/*` → `status:3478`, so pages are
  same-origin: `https://monitoring.home/s/<slug>` and `https://monitoring.entelechia.cloud/s/<slug>` (CF Access).

**Verify after rebase:** `GET /s/<slug>` 200 with the page's components; `/s/<slug>/api/v1/status.json` JSON.

## #10 — log retention: only important logs (BRIEF-uptime 4)

- `otel/builder-config.yaml` — adds `filterprocessor` v0.151.0 to the collector build.
- `apps/selfhost/compose/otel-collector.yaml` — `filter/important-logs` in the logs pipeline (after severity
  normalisation and trace-context lift): keep severity >= WARN everywhere; below WARN keep only logs carrying a trace_id,
  `wazuh-alerts`, Zitadel activity/auth lines, ssh/sudo/su auth lines and Kubernetes `Warning` events; severity-0 lines
  only when they look like errors. (This mirror also carries the BRIEF-traces collector edits made live on CT130:
  level-token severity inference and `transform/log-trace-context`.)
- `apps/selfhost/compose/clickhouse/retention.sql` — raw logs TTL 14 d -> 7 d.

**Verify after rebase:** `validate --config`; isolated collector fed the 15-case fixture keeps exactly the expected 8.

## #11 — status page tiers: core vs informational (BRIEF-tiers 2/3)

**Why:** the user wants a major outage (core services) told apart from informational noise (dev servers, media,
lab). Upstream has no per-component impact: a down monitor is always `major_outage`, auto incidents are hard-coded
`impact: "major"`, and every component drives the banner.

**Design chosen** (brief options, in order): (a) per-component impact does not exist upstream; (c) two pages would
duplicate config and split one view; so **(b) minimal patch keyed on the component GROUP NAME**: a component is
informational when its group starts with `Informational` (`INFORMATIONAL_GROUP_PREFIX`). No schema change, no
migration, no API change; set from `wiring/uptime-targets.yaml` (`tier: info` + an `Informational · …` group,
enforced by `uptime-monitors.py`). Upstream pages never use that prefix, so their behaviour is unchanged. Discord
silence for info is pure config (monitor `destination_ids: []`; the backing alert rule still opens/resolves its
incident, so status-page auto incidents still work).

**Upstream files touched:**
- `packages/domain/src/status-page.ts` — `isInformationalGroup`; `deriveComponentStatus({informational})` (down ->
  `degraded`); `overallStatus` (banner) ignores informational components; **fix** `uptimePercent` counts failed
  checks (upstream counted only checks while the monitor was already down, so an orange "degraded" day showed
  "100% uptime"); `rowStatus` = row/group icon is at least degraded when today's bar has failures.
- `packages/backend/src/services/status-pages/auto-incidents.ts` — reads `group_name`; impact `minor` when every
  component of that monitor on the page is informational, else `major`.
- `packages/backend/src/services/status-pages/StatusPageSnapshotBuilder.ts`, `packages/status-page/src/preview.ts`,
  `apps/web/src/page/status-pages/shared/derive.ts` — pass `informational` to `deriveComponentStatus`.
- `packages/status-page/src/{page,select,script,styles}.ts` — row/group icons from `rowStatus`; hero "Affected" lists
  core only; one `Informational · does not affect the overall status` divider before the first informational group;
  the client script's window uptime uses failures (same as the server).
- Tests: `packages/domain/src/status-page.test.ts` (upstream uptime expectation 99.5 -> 99 = the new semantics, + tier
  cases), `packages/status-page/src/render.test.ts` (divider/hero/icon), `packages/backend/src/services/alerts/
  AlertsService.uptime.test.ts` (minor vs major auto incident). Negative controls: each of the 5 behaviours sabotaged
  -> a test went red.

**Verify after rebase:** `vitest run` in packages/domain, packages/status-page, and
`packages/backend src/services/alerts/AlertsService.uptime.test.ts src/services/status-pages`; `tsrs --noEmit` in
domain/status-page/backend/web; live: an info monitor down shows "Degraded performance" under Informational, banner
stays operational, no Discord message.

## #12 — uptime failures are not error issues (BRIEF-tiers simulation finding)

**Why:** every failing check produced spans with `StatusCode = Error` (the `maple-uptime` check span and, with
PATCHES #8, the SERVER target span under the monitored service). Maple's error tracker turned them into error issues
and the org error-notification policy posted "Error Rate · in <service>: Triggered" to Discord — so an
**informational** monitor still pinged Discord, and core monitors pinged twice. Uptime alerting belongs to the
monitor's own rule (which honours its destinations / tier).

- `apps/scraper/src/UptimeSpans.ts` (fork-only target span, PATCHES #8) — target span status UNSET (`code: 0`); the
  check span keeps Error so uptime history/queries are unchanged.
- `packages/query-engine/src/ch/queries/errors.ts` — **upstream file**: the three error-tick scans
  (`errorTickIssuesQuery`, `errorTickFirstErrorMinuteQuery`, `errorTickBootstrapIssuesQuery`) skip
  `ServiceName = 'maple-uptime'` (upstream's prober is the same service; its failures are uptime incidents already).
  Error *pages* still show them; only issue creation/notification skips them.
- Tests: `apps/scraper/src/UptimeTargetSpans.test.ts`, `packages/query-engine/src/ch/queries/errors.test.ts`
  (both red when the change is removed).

**Verify after rebase:** `vitest run` in apps/scraper + packages/query-engine; a dead-port test monitor produces no
"Error Rate" Discord message.
