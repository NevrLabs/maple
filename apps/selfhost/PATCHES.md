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
