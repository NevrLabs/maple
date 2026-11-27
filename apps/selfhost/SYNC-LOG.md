# Upstream sync log — NevrLabs/maple selfhost fork

One section per sync run, newest last. Fork line: `selfhost-homelab-*` branches carry the
selfhost patches (catalogue: `apps/selfhost/PATCHES.md`); `main` tracks upstream as a mirror.

## Charter (owner handoff 2026-11-11)

Terminus owns this fork: maintenance, upstream sync, stability, and its direction. Standing rules:
- Every change is logged: sync runs here, behavioral fork changes as numbered PATCHES.md entries.
- Daily upstream probe (T3 scheduled task); a material range starts a run, no range = no output.
- Fork `main` = pure upstream mirror (fast-forward only). Work rides `selfhost-homelab-up-<date>[-n]`.
- A run is complete only with green `selfhost gates` whose headSha == branch head.
- Owner gates (never self-authorized): CT130 deployment/image rollout, prod DB writes, and any
  upstream contribution — candidates are proposed to the owner first (see "Upstream contributions").

## Upstream contributions (owner approved filing 2026-11-11)

Each PR rides a clean `pr/<name>` branch off upstream/main carrying only the generic fix (no
selfhost code; #16's native-scope half stays fork-only). Before filing, `check/<name>` = PR commit +
fork-only `.github/workflows/upstream-pr-check.yml` runs format (changed files only — upstream's
own tree is not oxfmt-clean), typechecks, SQL catalog, audit/Cloudflare suites and the real-CH e2e.
When a PR merges upstream, the next sync absorbs it: drop or shrink the matching PATCHES entry.

| Patch | Upstream PR | Branch / head | Pre-check |
|---|---|---|---|
| #15 first-mount sparkline sizing | https://github.com/MapleTechLabs/maple/pull/2498 — **merged** (`8a6f7b50c`), absorbed run 5 | `pr/sparkline-first-mount-height` `5ed2676c5` | green 43048183588 |
| #17 capability-denied CF datasets | #2499 closed unmerged; [#2862](https://github.com/MapleTechLabs/maple/pull/2862) merged as `aac5c9655`, absorbed run 11 | `pr/cloudflare-capability-denied` `1656567f0` | green 43048191135 |
| #16 TRC-01 all-kind parents | pending pre-check | `pr/trc01-all-kind-parents` `b830a0cff` | first run caught a stale upstream SQL-text pin (fixed); re-check 43096320674 |

## Run 1 — 2026-11-11 — upstream e231894bc → current upstream/main

Status: **COMPLETE — merged, gated, pushed.** Branch `selfhost-homelab-up-20261111` head `89c63d733`.
NOT deployed: CT130 still runs images `up-fd23f5f0` (deployment is a separate owner gate).

- Driver: dedicated Maple thread (T3 project `NEVR - Maple`), first run of the standing
  monitor-and-sync job.
- Frozen at run start:
  - fork main `d2b1413ea5` (pure mirror, 0 ahead / 404 behind upstream)
  - deployed selfhost line `selfhost-homelab-up-20261108` tip `fd23f5f06` (merge of upstream
    `e231894bc6`; PATCHES #1–#17; deployed on CT130 2026-11-09 as images `up-fd23f5f0`)
  - upstream/main `1e96be8a1b` ("feat(web): rename Code review to Review & CI (#2481)")
- Incoming range: 98 upstream commits, 5011 files, heavy in apps/web, packages/views,
  packages/backend, packages/domain. Upstream also touched `apps/selfhost` (46 files).
- Phases:
  1. [x] Evidence: topology, catalogue, PR count, builder capacity
  2. [x] Mirror: fork `main` fast-forwarded `d2b1413ea5` → `1e96be8a1b`, pushed
  3. [x] Candidate branch `selfhost-homelab-up-20261111` from `fd23f5f06`, merge commit `374d54caf`
        (parents `fd23f5f06` + `1e96be8a1`); 24 conflicted files resolved, zero markers left
  4. [x] Conflict resolution against PATCHES #1–#17 — see the 2026-11-11 section in PATCHES.md
        (setup-audit engine move ported: #16/#17 re-applied on the new engine; #1/#2/#3/#5/#13/#14
        adapted to upstream refactors; SQL baseline hand-combined, to be verified by catalog test)
  5. [x] Gates — builder circuit went down mid-run; completed on **GitHub Actions** instead
        (fork workflow `selfhost gates`, branch-scoped, green run
        https://github.com/NevrLabs/maple/actions/runs/42979319461 at `fd75cb685`):
        install, effect-sdk build, typechecks ×6 (domain, query-engine,
        query-engine-integrations, backend, views, web), suites: query-engine-integrations
        full (SQL catalog incl. the hand-merged baseline ✓), backend setup-audit ✓,
        backend warehouse driver ✓ (incl. the fork's CH e2e file, import-only fixes),
        web merge surfaces ✓ (71 files; alerts/sign-in/services/settings/shell/route/platform).
        Fix-ups the gates caught, all committed: uptime `.pipe(` close, native-span helper
        typing (narrow structural input), LOG-02 native pass detail, CFG-INTEG-02 test notes
        on upstream's grouped format, viewer-gate restored to upstream's branch shape
        (members keep the header action; only fork viewers hidden), sign-in rebuilt from
        upstream + 3-way oidc delta (upstream's "Couldn't reach the server" copy), stale
        `@maple/domain/primitives` + `./clickhouse-e2e-support` imports in the fork's CH e2e.
  6. [x] Push: mirror `main` → `1e96be8a1b`; candidate branch → `89c63d733` (regenerated
        bun.lock committed from the green run's artifact — matches the tree the gates ran).
  7. [x] Report — delivered in-thread; deployment left as an explicit owner decision.
- Known cosmetic debt (post-gates): UptimeMonitorsService.ts record block carries one-level
  shallower indentation than upstream's surrounding code (merge-resolution artifact, compiles).
- Out of scope this run (separate owner gates): image builds, CT130 deployment, pod-memory
  and noovoleum-images branch rebases.

## Run 2 — 2026-11-11 — upstream 1e96be8a1b → 5d9f5cff8

Status: **COMPLETE — merged, gated, pushed.** Branch `selfhost-homelab-up-20261111-2` head
includes merge `e0c32562c` (parents `9feca3e9` + `5d9f5cff8`). NOT deployed: CT130 still runs
images `up-fd23f5f0`; run 1's deployment remains the pending owner decision and run 2 is a
superset of run 1 (it contains run 1's tip as a parent).

- Driver: standing monitor handoff, first-action probe `fd23f5f06..upstream/main` = 105, of
  which 98 were already merged in run 1 → material new range = 7 commits since `1e96be8a1b`.
- Frozen at run start: fork main `1e96be8a1b` (mirror), run-1 branch tip `9feca3e9`,
  upstream/main `5d9f5cff8`, deployed line `fd23f5f06` (untouched).
- Incoming range: 7 commits, 154 files (+982/−516): security findings tabs on Overview
  (#2487), cancellation-review report page (#2486), lockfile fixture hygiene (#2485),
  members confirm-strip wrap (#2484), UI contrast tokens (#2483), landing docs (#2480/#2482).
- Mirror: origin `main` fast-forwarded `1e96be8a1b` → `5d9f5cff8`, pushed.
- Merge `e0c32562c`: clean auto-merge, zero conflicts. Post-merge patch-survival checks on the
  three fork-overlap surfaces: `route/search.ts` keeps `oidc_error` + `dead` beside upstream's
  `SecurityFindingStatusTab`; `lab/registry.ts` keeps `/lab/bench/ui-lag` beside upstream's new
  `/lab/members`; alerts hub viewer gate (#5) intact — upstream's only hub delta is a contrast
  class in `view-empty.ts`; `settings/members/view.ts` confirm-strip fix landed. No
  `package.json` changes upstream; none of the PATCHES #1–#17 upstream files touched.
- Gates — GitHub Actions fork workflow `selfhost gates`, green run
  https://github.com/NevrLabs/maple/actions/runs/43023839314 at `e0c32562c` (dispatch headSha
  verified == branch head both at queue time and on the completed run).
- bun.lock: artifact from the green run byte-identical to the committed lock (no dependency
  graph change) — no lock commit this run.
- Deployment: out of scope (owner gate). If the owner deploys, run 2 supersedes run 1 as the
  candidate; pre-cutover baseline/rollback procedures unchanged.

## Run 3 — 2026-11-12 — upstream 5d9f5cff8 → 4a0ddd7d3

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261112`,
gated head `6a7e73227` (merge `0d404a596`, parents `eb9a870d5` + `4a0ddd7d3`). Gates ran on the
MacBook (owner-directed while Actions is blocked), not on Actions. NOT deployed.

- Frozen at run start: fork main `5d9f5cff8` (mirror), run-2 tip `a7390dd5d`, upstream/main
  `4a0ddd7d3`, deployed line `fd23f5f06` (untouched).
- Incoming range: 20 commits, 606 files (+132k/−2.2k): cloud cost module (cost_daily, AWS Cost
  Explorer adapter, `/cost` page), Vercel + AI Gateway integration, status-page incident dialogs /
  RSS / custom domains / internal visibility, hex-tile service map, Security Center role gate,
  uptime "no recent check ≠ up", alert preview read scopes. package.json changes:
  `apps/status`, `packages/domain` (bun.lock regenerates in the gate).
- Mirror: origin `main` fast-forwarded `5d9f5cff8` → `4a0ddd7d3`, pushed.
- Merge `0d404a596`: 12 conflicts, all resolved hunk-by-hunk (no whole-file side picks):
  - #3 Proxmox registration beside upstream's new Vercel provider: `infra-surfaces.ts`
    (INTEGRATION_IDS + PENDING both), `nav.ts`, `route/{app-route,routers,search}.ts`,
    `view.lazy.test.ts` — both entries kept; routers' Proxmox pipe close restored.
  - #11 informational tier: upstream centralised the banner in `pageStatus` (web derive, now also
    feeding the new `statusChanges` preview) and moved `overallStatus` to
    `StatusPagePublicSnapshot`. The informational filter moved INTO `pageStatus` and the new
    `overallStatus` signature, so editor badge, page-list summary and the incident-dialog change
    preview all exclude informational groups; `select.ts` keeps `rowStatus` on the public type.
  - #11 fork test blocks (`domain/status-page.test.ts`, `status-page/render.test.ts`) rebuilt from
    upstream + the fork delta (upstream appended custom-domain / branding / link-preview / times
    suites at the same EOF).
  - Survival sweep: every fork-added line on the 35 overlap files is present post-merge except
    the three #11 filter lines, which now live in the shared functions above (verified by
    reading). Auto-merged overlaps checked by token: `oidc_error`/`dead` search params,
    `ui-lag` lab entry, liveness, uptime tier, setup-audit native/unavailable helpers, format cache.
- Gates workflow amended (`6f0746814`): adds `packages/status-page` typecheck, a #11 status-tier
  suite (domain status-page, status-page package, backend uptime alerts + status-pages) and the
  web `status-pages` + `view.lazy` surfaces.
- Initial blocker (superseded by the MacBook gate below):
  - GitHub Actions: `gh workflow run 'selfhost gates' --ref selfhost-homelab-up-20261112` →
    `HTTP 422: Actions has been disabled for this repository`, while
    `GET /repos/NevrLabs/maple/actions/permissions` reports `enabled:true` and the workflow is
    `active`. Every run on the owner's account has been stuck `queued` since 2026-11-11T20:29Z
    (fork #16 pre-check 43096320674; IEatCodeDaily/hermes-agent runs from 01:40Z) — an
    account-level Actions restriction (billing/spending limit or flag), not a repo setting.
  - Alternate route fxbuilder (dumbpipe circuit): `ssh fxbuilder` → `timed out` (2 probes,
    02:0xZ). Local build on Eternus refused by policy.
- Gates — MacBook (`macbook`, Darwin arm64, bun 1.4.4, node v22.23.4 vs mise-pinned 24.18.0),
  script mirroring `.github/workflows/gates.yml` step-for-step, fresh clone of the pushed branch,
  ledger `~/ci/maple-gates/<sha>/ledger` asserting checked-out HEAD == expected SHA:
  - attempt 1 `2cee3eeaf`: typechecks ×7 green; `packages/status-page` red — upstream's new
    `uptime.test.ts` (uptime.json feed) pinned upstream's uptime math; #11 counts every failed
    check, so the degraded day reads 99.7916 and the window 99.2361 (fixture: 3/1440 + 30 down of
    4320). Expectation updated (`741b09ca2`), same precedent as the domain 99.5→99 pin.
  - attempt 2 `741b09ca2`: backend #13 tier tests red — `ReferenceError: AlertsService is not
    defined`: upstream's test refactor replaced the `AlertsService` import with the
    `alertServices` facade; the two fork tests now use it (`6a7e73227`).
  - attempt 3 `6a7e73227`: **all green**, `DONE 6a7e73227`. install, effect-sdk build,
    typechecks (domain, status-page, query-engine, query-engine-integrations, backend, views,
    web), suites: qe-integrations 508/508, backend org 415/415, backend warehouse 169 passed /
    515 skipped (real-CH e2e, env-gated as on Actions), domain status-page 45/45, status-page
    85/85, backend uptime alerts + status-pages 140/140, web merge surfaces 937/937 (81 files).
- bun.lock: lock regenerated by the green run byte-identical to the committed merged lock — no
  lock commit.
- Actions remains blocked at account level (`HTTP 422 Actions has been disabled`); the next run
  can gate on the MacBook again or on Actions once it dispatches.

## Run 4 — 2026-11-13 — upstream 4a0ddd7d3 → 55baa2595

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261113`,
gated head = merge `3573605e7` (parents `9eb101a4c` run-3 tip + `55baa2595`). NOT deployed.

- Frozen at run start: fork main `4a0ddd7d3`, run-3 tip `9eb101a4c`, upstream/main `55baa2595`.
- Incoming range: 25 commits, 204 files (+53.8k/−0.9k): Cost page filters/sources/OpenRouter,
  ingest log batches on self-managed ClickHouse 25.x (#2500), clickhouse-http invalid UTF-8 →
  U+FFFD (#2511), AWS connection card + read-only role pin, billing AI credits, browser-session
  error noise, effect-sdk export-outage log, Home log-volume read split. No package.json changes.
- Mirror: origin `main` fast-forwarded `4a0ddd7d3` → `55baa2595`, pushed.
- Merge `3573605e7`: auto-merged, 0 conflicts. Overlap with the fork delta = 7 web files
  (`lab/registry.ts`, `page/registry.ts`, `route/{app-route,routers,search}.ts`, `update.ts`,
  `view.lazy.test.ts`); every fork-added line on them is present post-merge (line sweep).
- Gates: `gh workflow run` → `HTTP 422 Actions has been disabled` (unchanged). MacBook
  `scripts/mac-gates.sh` (== gates.yml steps), ledger `~/ci/maple-gates/3573605e7…/ledger`,
  head asserted == `3573605e7`: **all green**, `DONE 3573605e7`. Typechecks ×7 green; suites:
  qe-integrations 508/508, backend org 415/415, backend warehouse 169 passed / 515 skipped,
  domain status-page 45/45, status-page 85/85, backend uptime alerts + status-pages 140/140,
  web merge surfaces 944/944.
- bun.lock: regenerated lock byte-identical to the committed one (sha256 `9eb3e99e…`) — no
  lock commit.

## Run 5 — 2026-11-14 — upstream 55baa2595 → cf227e825

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261114`,
gated head = merge `35695db00` (parents `b2448b871` #18 Atlas tip + `cf227e825`). NOT deployed.

- Frozen at run start: fork main `55baa2595`, selfhost tip `b2448b871` (run-4 docs + PATCHES #18),
  upstream/main `cf227e825`.
- Incoming range: 44 commits, 745 files (+115.9k/−3.9k): analyst role (policy, auth, MCP/chat, shell,
  members, Overview), Security hub audit trail + detections, cost sources (GitHub, Vercel, Cloudflare,
  PlanetScale, Anthropic, OpenAI), Geist UI refresh + chart chrome/zoom, ingest per-request cost bounds,
  scoped-key/role hardening, db migration-branch join, #2498 (our #15). package.json changes in cli,
  alchemy-maple, browser, domain, effect-sdk, views (version bumps).
- Mirror: origin `main` fast-forwarded `55baa2595` → `cf227e825`, pushed, read back.
- Merge `35695db00`: 2 conflicts, both resolved by hand:
  - `apps/web/src/page/alerts/hub/view.ts` `headerActions`: upstream's analyst gate (`audience ===
    "analyst"` → no actions on any tab) first, then #5's `isViewerSession()` gate on inbox/rules kept.
  - `packages/views/src/charts/chart-mounts.ts`: upstream side taken — #15's sizing half merged upstream
    as #2498 (identical logic, upstream formatting); file now == upstream. PATCHES #15 shrunk.
- Survival sweep (`55baa2595` → `b2448b871`): 25 overlap files; only MISSING lines are the two #15
  chart-mounts lines above (superseded by #2498). #18 Atlas registrations, #14 liveness, #13 tier,
  #1 SQL baseline, format.ts cache all present.
- Gates: `gh workflow run` → `HTTP 422 Actions has been disabled` (unchanged). MacBook
  `scripts/mac-gates.sh`, ledger `~/ci/maple-gates/35695db00…/ledger`, head asserted == `35695db00`:
  **all green**, `DONE 35695db00`. Typechecks ×7 green; suites: qe-integrations 507/507, backend org
  415/415, backend warehouse 169 passed / 515 skipped, domain status-page 45/45, status-page 85/85,
  backend uptime alerts + status-pages 140/140, web merge surfaces 971/971.
- bun.lock: regenerated lock byte-identical to the committed merged lock (sha256 `ffc56d7e…`) — no
  lock commit.
- Note: upstream's new `analyst` role overlaps conceptually with #5's selfhost `viewer`; both gates
  coexist. Candidate for later: map viewer onto analyst and drop the fork gate.

## Run 6 — 2026-11-15 — upstream cf227e825 → acddf136e

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261115`,
gated head = merge `584f0e805` (parents `4c877db8b` run-5 tip + `acddf136e`). NOT deployed.

- Frozen at run start: fork main `cf227e825`, selfhost tip `4c877db8b` (run-5 docs),
  upstream/main `acddf136e`.
- Incoming range: 40 commits, 595 files (+99.1k/−11.4k): integrations provider modules + shared
  vendor HTTP kit / poller blocks (Cloudflare, PlanetScale, Vercel, Railway, Supabase, GCP, GitHub,
  Linear, Search Console), deployment-secret catalog, backend runtime secrets as services, Product
  analytics page (events/funnels/paths), sources list grouped by health, loading skeletons, sidebar
  sub-rows, alerting org-scoped warehouse reads (flagged), deps (effect 4.1.4, alchemy beta.87,
  oxlint 1.93, oxfmt 0.78), landing/docs design.
- Mirror: origin `main` fast-forwarded `cf227e825` → `acddf136e`, pushed, read back.
- Merge `584f0e805`: auto-merged, 0 conflicts, no markers; no fork-touched file deleted/renamed
  upstream. Survival sweep (`cf227e825` → `4c877db8b`): 15 overlap files (web route/registry/nav/
  main/update/view-table/view.lazy.test, bun.lock, CloudflareAnalyticsService.test, setup-audit.test,
  WarehouseQueryService{,.test}) — zero MISSING fork lines.
- Gates: `gh workflow run` → `HTTP 422 Actions has been disabled` (unchanged). MacBook
  `scripts/mac-gates.sh` (step list re-checked == gates.yml), ledger `~/ci/maple-gates/584f0e805…/ledger`,
  head asserted == `584f0e805`: **all green**, `DONE 584f0e805`. Typechecks ×7 green; suites:
  qe-integrations 507/507, backend org 419/419, backend warehouse 174 passed / 515 skipped,
  domain status-page 45/45, status-page 85/85, backend uptime alerts + status-pages 140/140,
  web merge surfaces 974/974.
- bun.lock: regenerated lock byte-identical to the committed merged lock (sha256 `086fa50c…`) — no
  lock commit.

## Run 7 — 2026-11-16 — upstream acddf136e → 64d696235

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261116`,
gated head = merge `6867394c1` (parents `5b3305aa4` run-6 tip + `64d696235`). NOT deployed.

- Frozen at run start: fork main `acddf136e`, selfhost tip `5b3305aa4` (run-6 docs),
  upstream/main `64d696235`.
- Incoming range: 37 commits, 625 files (+226.2k/−10.6k): OTLP profiles end to end (warehouse table,
  ingest on every gateway, effect-sdk CPU profiling, flame chart + span Profile tab, Maple Local),
  Prometheus remote write ingest, org-scoped Tinybird tokens for tenant reads, profile billing,
  integration feature switches, cost budgets as managed alert rules + budgets pages, histogram
  percentiles, saved explorer views, deploy judgement/drawer on the service page (Releases pages
  retired), verified domains in Settings, aws_metrics_hourly rollup, audit names for Maple agents.
- Mirror: origin `main` fast-forwarded `acddf136e` → `64d696235`, pushed, read back.
- Merge `6867394c1` (in a separate worktree; the main checkout's uncommitted postgres-integration
  work left untouched): 4 conflicts, all additive tab-union arms in `apps/web/src/page/settings/`
  — upstream's new `Domains` tab beside #5's `SelfhostMembers`: `model.ts` (union arm), `nav.ts`
  (#5 members OIDC visibility kept; upstream's admin-only `domains` rule added), `update.ts`
  (tab map + revisit case), `view.ts` (description case). Both sides kept in each.
- Survival sweep (`acddf136e` → `5b3305aa4`): 24 overlap files — zero MISSING fork lines.
- Gates: `gh workflow run` → `HTTP 422 Actions has been disabled` (unchanged). MacBook
  `scripts/mac-gates.sh` (step list re-checked == gates.yml), ledger `~/ci/maple-gates/6867394c1…/ledger`,
  head asserted == `6867394c1`: **all green**, `DONE 6867394c1`. Typechecks ×7 green; suites:
  qe-integrations 512/512, backend org 423/423, backend warehouse 177 passed / 523 skipped,
  domain status-page 45/45, status-page 85/85, backend uptime alerts + status-pages 140/140,
  web merge surfaces 989/989.
- bun.lock: regenerated lock byte-identical to the committed merged lock (sha256 `086fa50c…`) — no
  lock commit.

## Run 8 — 2026-11-17 — upstream 64d696235 → c081ca2cd

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261117`,
gated head = merge `f96b904b2` (parents `eb70d1320` run-7 tip + `c081ca2cd`). NOT deployed.

- Frozen at run start: fork main `64d696235`, selfhost tip `eb70d1320` (run-7 docs),
  upstream/main `c081ca2cd`.
- Incoming range: 50 commits, 554 files (+174.6k/−4.9k): SSO (SAML/OIDC) + SCIM add-ons and settings
  tab, status-page editor redesign (Live page / Incidents / Maintenance / Settings, statusPages org flag
  again), HTTPS certificate-expiry warnings on uptime monitors, AWS security findings + CloudTrail into
  the audit log, profile_hotspots MCP tool, quieter anomaly detection, expected-4xx/vendor-refusal noise
  cuts across api/cli/integrations/scraper, OpenRouter BYOK provider order, actions bumps, landing.
- Mirror: origin `main` fast-forwarded `64d696235` → `c081ca2cd`, pushed, read back.
- Merge `f96b904b2` (separate worktree; main checkout's uncommitted postgres-integration work untouched):
  4 conflicts, resolved by hand:
  - `apps/web/src/page/settings/nav.ts`: #5 members OIDC visibility kept beside upstream's new `sso` rule.
  - `apps/web/src/page/status-pages/shared/derive.ts`: upstream's `statusReason` taken with the #11 banner
    doc; a down informational monitor's `degraded` counts as the monitor's own status (new test in
    `derive.test.ts`).
  - `packages/backend/src/services/alerts/AlertsService.uptime.test.ts`: #11/#13 tier tests and upstream's
    certificate tests both kept.
  - `packages/status-page/src/page.ts`: #11 divider moved into upstream's `flatMap`/`onlyId` panel (full
    panel only); core-only "Affected" filter moved into upstream's `renderPageHero`. PATCHES #11 updated.
- Survival sweep (`64d696235` → `eb70d1320`): 25 overlap files; the only MISSING lines are the four
  `page.ts` lines above, re-expressed inside upstream's restructure (render.test tier cases green).
- Gates: `gh workflow run` → `HTTP 422 Actions has been disabled` (unchanged). MacBook
  `scripts/mac-gates.sh` (step list re-checked == gates.yml), ledger `~/ci/maple-gates/f96b904b2…/ledger`,
  head asserted == `f96b904b2`: **all green**, `DONE f96b904b2`. Typechecks ×7 green; suites:
  qe-integrations 512/512, backend org 449 passed / 1 skipped, backend warehouse 177 passed / 523 skipped,
  domain status-page 45/45, status-page 85/85, backend uptime alerts + status-pages 146/146,
  web merge surfaces 1042/1042.
- bun.lock: regenerated lock byte-identical to the committed merged lock (sha256 `144a6ac6…`) — no
  lock commit.

## Decision of record — 2026-11-17T12:17Z — FORK DEPLOY: APPROVED

Owner (Raisal) go for deploying the selfhost fork to CT130: given orally in the Maple cutover thread
2026-11-15/16 ("already said go"), reconfirmed 2026-11-17 via the chief-of-staff thread, recorded in
writing in the Maple sync thread 2026-11-17T12:17Z. This entry is the durable record.

- Scope: Run 8 (`selfhost-homelab-up-20261117` @ `94c2913af`, merge `f96b904b2`, gates green) — it
  contains Runs 2–7, so one image set built from it replaces CT130's `up-fd23f5f0`. No Run 5/6 image
  set exists on CT130, talos or the MacBook (checked 2026-11-17T12:17Z); images get built from Run 8.
- Covers: image build + transfer, PG and ClickHouse migrations on the live databases (28 new drizzle
  migrations, 9 new CH migration files since `fd23f5f06`), bounded service recreate, per the
  `~/deploy/maple/BRIEF-upstream-DEPLOY.md` order (backup, PBS snapshot, restore rehearsal first).
- Not covered (still separate): destructive DB restore/rollback; Telegram; upstream PRs.

## Run 9 — 2026-11-18 — upstream c081ca2cd → 019e4d9d1

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261118`,
merge `05c47b54c` (parents `69c36f75e` run-8 tip + `019e4d9d1`), gated head `4c187d1e2` (merge + gates
extension). NOT deployed (the run-8 deploy approval covers run 8 only).

- Frozen at run start: fork main `c081ca2cd`, selfhost tip `69c36f75e` (run-8 decision of record),
  upstream/main `019e4d9d1`.
- Incoming range: 49 commits, 629 files (+104.7k/−7.0k): status-page editor (click-to-edit preview,
  logo/favicon uploads, custom colours, list cards with components/uptime/maintenance, custom-domain TXT
  proof, password bounds, prd status domain), multi-step API uptime checks + request-body sealing, AWS
  security findings via EventBridge + Cloud findings tab, permission-gated controls shown disabled,
  engineer policy grants, PR-review auto-approval (admin setting), SSO connection cleanup, API key
  lifetime bounds, settings tabs as paths, Cloud cost open to every org, db migration ordering fixes.
- Mirror: origin `main` fast-forwarded `c081ca2cd` → `019e4d9d1`, pushed, read back.
- Merge `05c47b54c` (separate worktree; main checkout's uncommitted postgres-integration work untouched):
  5 conflicts, resolved by hand:
  - `apps/scraper/src/UptimeSpans.ts` (#8): fork target-span structure kept; check spans now use upstream's
    `toOtlpSpans` (multi-step child spans). Auto-merge had duplicated `OtlpSpan.parentSpanId`; dropped.
  - `apps/web/src/page/alerts/hub/view.ts` (#5): upstream removed the `canManageAlerts` early return
    (non-managers get disabled controls with a denial tooltip); the viewer early return moved above the
    tab switch so a viewer still sees no create action on any tab. PATCHES #5 updated.
  - `apps/web/src/page/status-pages/shared/derive.ts` + `derive.test.ts` (#11): both import sets kept;
    upstream's `summarizePage` now reads the public snapshot (`overallStatus` already excludes
    informational groups), so the #11 banner test was re-expressed on snapshot fixtures.
  - `packages/status-page/src/page.ts` (#11): tier-head kept beside upstream's group `previewIdAttr`.
- Survival sweep (`c081ca2cd` → `69c36f75e`): 26 overlap files; MISSING lines are only the re-expressed
  ones above (`group.map(toOtlpSpan)` → `Arr.flatMap(group, toOtlpSpans)`, the moved #5 comment, the old
  monitor-based #11 summary test).
- Gates extended: the scraper conflict surface was ungated, so `gates.yml` (commit `4c187d1e2`) and
  `scripts/mac-gates.sh` add `apps/scraper` typecheck + `UptimeSpans`/`UptimeTargetSpans` suites.
- Gates: `gh workflow run` → `HTTP 422 Actions has been disabled` (unchanged). MacBook
  `scripts/mac-gates.sh`, ledger `~/ci/maple-gates/4c187d1e2…/ledger`, head asserted == `4c187d1e2`:
  **all green**, `DONE 4c187d1e2`. Typechecks ×8 green; suites: qe-integrations 512/512, backend org
  459 passed / 1 skipped, backend warehouse 177 passed / 523 skipped, domain status-page 48/48,
  status-page 96/96, backend uptime alerts + status-pages 159/159, scraper spans 14/14, web merge
  surfaces 1102/1102.
- bun.lock: regenerated lock byte-identical to the committed merged lock (sha256 `144a6ac6…`) — no
  lock commit.

## Image build — 2026-11-18 — Run 8 deploy prep (MacBook, colima)

Owner decision 2026-11-18: Docker Desktop on the MacBook is replaced by colima (pure CLI, OSS). colima 0.10.3,
VZ + Rosetta, 6 CPU / 8 GiB / 60 GiB, docker context `colima`; Desktop state not migrated, Desktop left
installed-but-unused. The CLI config no longer depends on Docker.app (desktop creds helper dropped, brew
plugins dir, Desktop plugin links moved to `~/.docker/pre-colima-20261118T022646Z/`).

Building the approved Run 8 image set from `94c2913af` failed: no run since run 2 produced a deployable tree.
Fixed on `selfhost-homelab-up-20261117` (cherry-picked onto `-20261118`):
- `99e51583c` `apps/selfhost/src/ports.ts` imported `@maple/backend/platform/chat-sessions-fake`, moved to
  `testing/` by upstream #2472 (run 2 range). Typecheck never covered `apps/selfhost`, so the gates missed it;
  `build-images.sh bundles` (docker-free) is now a gate step in `gates.yml` + `mac-gates.sh`.
- `6eab0b523` upstream #2446 deleted `apps/web/nginx.conf`; the deployed `fd23f5f06` copy is kept
  byte-identical at `apps/selfhost/compose/web-nginx.conf`.
- `08c27d73a` upstream #2726 lifted the exporter go.mod to otel v1.47 (otel/log v1.x); collector v0.151's
  otelzap v0.18 / sdk/log v0.19 do not compile against it. `build-images.sh` pins the otel family to the
  deployed v1.45 set (otel/log v0.19.0) via ocb replaces; exporter unit tests pass under the pins.
- Gates green at `08c27d73a` (run 8 line) and `684150c74` (run 9 line), ledgers `~/ci/maple-gates/<sha>/`.
- Images `up-08c27d73` (linux/amd64, MacBook colima, ledger `~/ci/maple-images/up-08c27d73/ledger`):
  maple-selfhost `sha256:26ed9f8d…`, maple-web `sha256:cfdffe12…`, maple-otel-collector `sha256:a28f2e24…`,
  maple-ingest `sha256:ce77f75f…`. The deploy approval names `94c2913af`; these images are `94c2913af` +
  the three build fixes above (no runtime-behaviour change beyond making the bundle resolve).
- NOT deployed. Pre-deploy Setup Health 39/5 differs from the approved 37/7 baseline (STAT-02 new;
  NAME-03, CFG-NOTIF-01, STAT-04 cleared) — the runbook requires baseline reconciliation before cutover.

## Run 10 — 2026-11-19 — upstream 019e4d9d1 → 486316866

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261119`,
merge `fc7408ba2` (parents `ba2c15a12` run-9/image-prep tip + `486316866`), gated head `593f61000`
(merge + #2828 session-key adaptation). NOT deployed.

- Frozen at run start: fork main `019e4d9d1`, selfhost tip `ba2c15a12` (newest gated line, carries the
  three image-path fixes), upstream/main `486316866`.
- Incoming range: 53 commits, 905 files (+167.0k/−4.6k): PromQL (parser/evaluator on the metric tables,
  Prometheus-compatible API, MCP tool, dashboard widget source, Grafana dashboard import), destination-bound
  v3 secret envelopes (ClickHouse/scrape/data-source/uptime; v2 refused for those slots), self-hosted login
  rate limit + strong root password + HKDF session key (#2828), raw SQL read-only on ClickHouse
  (`readonly=1` with a `readonly=2` profile fallback), status-page slugs per org (`/s/<org key>/<slug>`),
  Alchemy StatusPage/UptimeMonitor, GCP cost source, feature requests, org deletion service, GitHub org audit,
  ingest gateway hardening, landing.
- Mirror: origin `main` fast-forwarded `019e4d9d1` → `486316866`, pushed, read back.
- Merge `fc7408ba2` (separate worktree; main checkout's uncommitted postgres-integration work untouched):
  2 conflicts, resolved by hand:
  - `packages/backend/src/services/warehouse/WarehouseQueryService.ts` (#1): upstream's import list + `Config`
    (fork write-route env); upstream's new read-only `sql` (Ref-cached `readonly=1`) kept inside the fork's
    `Effect.flatMap(HttpClient…)` wrapper, with the #1 `insert` (`kind=clickhouse` → JSONEachRow) and
    `insertJsonEachRow` helper in place of upstream's always-fail insert.
  - `packages/domain/src/status-page.test.ts` (#11): fork `informational tier` suite and upstream's new
    `slugFromName` suite both kept (adjacent EOF insertions).
- Survival sweep (`019e4d9d1` → `ba2c15a12`): 15 overlap files; only MISSING line is the old single-line
  `effect` import in WarehouseQueryService (re-expressed as upstream's multi-line list + `Config`).
- Post-merge adaptation `593f61000` (not a text conflict): upstream #2828 signs self-hosted sessions with an
  HKDF-SHA256 key (`MAPLE_SESSION_SIGNING_SECRET` salted with the root password, else the password alone).
  The fork's OIDC mint/gate (#4/#5) signed with the raw root password, so every OIDC session would have
  401'd at the API. `session.ts` `sessionKey(env)` derives the same key; `api.ts`/`electric-sync.ts` use it;
  compose passes the optional secret; new `session.test.ts` resolves fork-minted tokens through upstream's
  `makeResolveTenant` with and without the secret. Deploy note: CT130's root password must be ≥16 chars and
  not a placeholder or the api refuses to start (upstream `rootPasswordProblem`); old sessions are invalidated
  by the key change (one re-login).
- Gates extended: `bun test apps/selfhost/src` (the selfhost server's own suites were ungated) in `gates.yml`
  and `scripts/mac-gates.sh`.
- Gates: `gh workflow run` → `HTTP 422 Actions has been disabled` (unchanged). MacBook
  `scripts/mac-gates.sh`, ledger `~/ci/maple-gates/593f61000…/ledger`, head asserted == `593f61000`:
  **all green**, `DONE 593f61000`. Bundles ✓, typechecks ×8 green; suites: qe-integrations 512/512, backend
  org 464 passed / 1 skipped, backend warehouse 182 passed / 524 skipped, domain status-page 50/50,
  status-page 96/96, backend uptime alerts + status-pages 162/162, scraper spans 14/14, selfhost 69/69,
  web merge surfaces 1115/1115.
- bun.lock: regenerated lock byte-identical to the committed merged lock (sha256 `f1717f21…`) — no lock commit.

## Deploy — 2026-11-19T06:54Z — Run 10 on CT130 (owner go, Maple sync thread)

CT130 runs `up-593f6100` (= `selfhost-homelab-up-20261119` @ `593f61000`) on all 8 Maple services, replacing
`up-fd23f5f0`. Built on the MacBook (colima, linux/amd64), streamed to CT130, image IDs verified.
- Pre-cutover: PBS `vzdump 130`; ClickHouse `maple/pre-run10-593f6100-20261119-0632` (3.65 GiB, after the SeaweedFS S3
  gateway recovered; seaweedfs-01 memory 1→2 GiB); writers stopped, quiesced pg_dump. PG migrations 176→212, CH 60–68.
- Upgrade trap, fixed: upstream reads only v2/v3 secret envelopes since #2458, and the reseal pass that rewrote pre-v2
  values lived only in the releases between #2456 and #2458, which this deployment skipped (fd23f5f06 → run 10).
  Five pre-v2 values (Discord destinations, one OAuth pair, the org ingest key) stopped opening: uptime target list 503,
  Discord deliveries failing. Resealed once in one transaction (legacy open with the master key → v2 seal, round-trip
  checked, dry run first). **Any other deployment upgrading across #2458 needs the same step** (the Noovoleum Maple runs
  fd23f5f06 too).
- Setup Health 37/9: RES-02/04/05 now fail because upstream #2429 judges them per service; NAME-03 cleared (upstream
  excludes Maple-written `maple_ai.*`). Owner baseline reconciliation pending.

## Fix — 2026-11-19T07:11Z — alerting `2-59/5` cron never fired self-hosted (PATCHES #19)

Found connecting the Cloudflare cost source on CT130: the token saved, but `cost_sync` never ran. Fix `6e6e26c46`
(gated green on the MacBook, selfhost 71/71); image `maple-selfhost:up-6e6e26c4` (`sha256:2c7d5b2a…`) on the
`alerting` container only, others stay `up-593f6100`. First tick 07:07Z: Cloudflare account `af929c6a…`,
2026-08-01 → 2026-11-18 synced (110 days, all US$0: the account's subscriptions are all free tiers).

## Feature — 2026-11-19T08:09Z — Atlas, Proxmox VE and PostgreSQL in Connect a source

`c8295a73b` adds the three push platforms (picker, snippets, source health, MCP descriptors) and the
PostgreSQL infra page. Gated green on the MacBook (20/20; web 126 files, domain 95, ai typecheck).
CT130: api/alerting/scraper/status/electric-sync on `maple-selfhost:up-c8295a73` (`0f6d7ad8`), web on
`maple-web:up-c8295a73` (`ffa02dd5`); ingest/collector unchanged; no migrations. Probe: create+delete
of a `mongodb_atlas`, `proxmox` and `postgresql` source via `/v2/sources` all 200.

## Run 11 — 2026-11-20 — upstream 486316866 → 6854ea260

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261120`;
merge and gated head `0c5d3f5f6` (parents `8ee1fcc57` + `6854ea260`). Not deployed.

- Frozen inputs: fork main `486316866741e5619c943fdcff7c98bf4350a44b`, selfhost tip `8ee1fcc57cb04d5e12cfc75c099ac96548487380`,
  upstream `6854ea2608bb48d37ded826da6ea000ac8835b35`. Previous tip's MacBook ledger confirmed `DONE 8ee1fcc57cb04d5e12cfc75c099ac96548487380`.
- Incoming range: 25 commits, 371 files (+109,903/−5,420): upstream Cloudflare capability handling (#2862),
  status-page cards and rollout-flag removal, sidebar badges, Clerk SDK and impersonation audit, org erasure,
  write-once audit archive, PromQL query bounds, ingest credentials, distilled integrations, and landing.
- Mirror: fork `main` fast-forwarded to `6854ea260` and verified on origin.
- Merge: six #17 conflicts resolved hunk-by-hunk. #2862 supersedes the fork's Cloudflare delta: it preserves
  cached denial on an indeterminate probe, stamps the settings TTL, recovers on definitive allow, and renders
  capped affected entities in passing Setup Health rows. The three Cloudflare-only resolutions match upstream;
  the three shared audit files retain the #16 native-scope and all-kind-parent changes.
- Survival sweep: 13 overlap files. All 42 missing lines were superseded #17 forms (probe/render logic, copy,
  or fixtures); no missing fork behavior or files. Informational status/uptime, navigation and identity deltas
  remained intact. Clerk changes leave the #5 selfhost HMAC wire format intact; the renamed audit intake queue
  is a Worker binding change, and the new replay eraser binding is optional.
- Gates: GitHub `selfhost gates` dispatch returned HTTP 422 (Actions disabled; no run ID).
  MacBook ledger `~/ci/maple-gates/0c5d3f5f68e823c968fa71d8e321562bfe283fb7/ledger`: exact pushed SHA confirmed by `head=` and `DONE`.
  SDK, bundles (no images), eight typechecks and all suites green: QE integrations 512; backend org + Cloudflare
  577 passed / 1 skipped; backend warehouse 188 passed / 524 skipped; domain status 50; status-page 96;
  backend uptime/status 162; scraper 14; selfhost 71; web 1115. The gate now includes CloudflareAnalyticsService.
- bun.lock: regenerated lock byte-identical (`48758b160458c84153ee0b7abc88d15c42dbacd5d8e799a72c39851796cd98af`); no lock commit.

## Run 12 — 2026-11-21, unblocked 2026-11-25 — upstream 6854ea260 → a0eed90f2

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261121`;
merge `06dfdcc04ad14db0d25f62ee934d6132f672f82e` (parents `980ea879cb68f44db41abe74b9a34d80b607a47d`
and `a0eed90f2f95f20f9cd57709113eda66c8b88714`), gated head `07818b0548d179ffec51cbd1c4031a9ddab3f018`. Not deployed.

- Incoming range: 22 commits, 365 files; Fleet and Devices, Grafana imports, Prometheus compatibility,
  Cloudflare Access for ClickHouse, alerts and ingestion fixes, and status-page link previews (#2891).
  Fork `main` already pointed at `a0eed90f2` on resumption and was read back unchanged.
- The original merge passed the suites but failed in-memory preview acceptance: `env.ogImage is not a function`.
  Upstream `5855e6e2cf` is 118 commits beyond this merge's upstream parent; the only status app change is a Wasm
  dependency bump. It does not supply the missing selfhost ports and was not merged in this repair.
- PATCHES #9: Bun now calls upstream's Takumi renderer with packaged Wasm and fonts. Status pages retain an
  explicit shared-host allowlist and both password budgets; remote logo URLs are not fetched by selfhost.
  The regression reproduced the exception before the fix. Source and bundled tests served a real 1200×630 PNG,
  rejected an unknown shared host, and kept password previews private and password attempts bounded.
- GitHub `selfhost gates` dispatch returned HTTP 422 (Actions disabled; no run ID). MacBook ledger
  `~/ci/maple-gates/07818b0548d179ffec51cbd1c4031a9ddab3f018/ledger`: matching `head=` and `DONE`;
  SDK, Docker-free bundles, eight typechecks and all suites green. QE integrations 512; backend org 577 passed /
  1 skipped; warehouse 195 passed / 524 skipped; domain status 50; status-page 111; backend status 162;
  scraper 14; selfhost 73; packaged status 2; web 1116.
- bun.lock: regenerated lock byte-identical (`360d3214d7827897dc743419d212f73b3c89db95e7f4814d00fb87c41ea6b30e`); no lock commit.

## Run 13 — 2026-11-26 — upstream a0eed90f2 → 75fed1715b

Status: **COMPLETE — merged, gated (MacBook), pushed.** Branch `selfhost-homelab-up-20261126`;
merge `f81bf7cf212867cd82319748831d284d96e1202f` (first parent `b577464a329d3f44ed768d6ff2d562533e9d117b`,
second parent `75fed1715b246a5760ec5eaca715aaa6ed2af887`), gated head `02c3e3153ea77146098943bd1faa1a2a5c2f923d`. Not deployed.

- Incoming range: 142 commits, 2590 files; custom roles and namespace-scoped reads, retention policy and read
  horizons, source maps, Services sparklines and commits, status-page incident bars, and docs/landing changes.
  Fork `main` fast-forwarded `a0eed90f2f95f20f9cd57709113eda66c8b88714` → `75fed1715b246a5760ec5eaca715aaa6ed2af887`; verified on origin.
- Resolved 17 conflicting files hunk by hunk. Swept all 46 overlap files, with no missing files and nine old
  lines accounted for: regenerated the MCP descriptors against the merged schemas (fork platforms retained),
  kept viewer gating with server permissions and dashboard action arguments, retained OIDC Members next to
  Clerk Roles, and ported #11 row icons and failure-counted uptime alongside incident-marked bars. The row
  icon regression now covers an isolated failure below upstream's new bar threshold. #14 liveness also applies
  to the new keyboard row navigation. #1's opt-in JSONEachRow writes remain separate from upstream read scoping.
- Regenerated the viewer route table (706 routes); all existing read allowlist IDs still resolve. The session
  signing format is unchanged. The Bun API now supplies the mandatory source-map ports without pretending
  to support durable uploads (#20). The status adapter contract is unchanged; its source and bundled regressions
  passed against the new Takumi Wasm version.
- Mechanical gate fixes: added timestamps to the offline Services sparkline fixture; updated eight package
  and two web status assertions to reflect upstream's changed fixtures with the fork's failed-check semantics.
- GitHub `selfhost gates` dispatch returned HTTP 422 (Actions disabled; no run URL). MacBook ledger
  `~/ci/maple-gates/02c3e3153ea77146098943bd1faa1a2a5c2f923d/ledger` matched the pushed SHA in `head=` and `DONE`.
  SDK, Docker-free bundles, eight typechecks and all suites green: QE integrations 512; backend org/Cloudflare
  607 passed / 1 skipped; warehouse 235 passed / 540 skipped; domain status 69; status-page 118; backend
  uptime/status 162; scraper 14; selfhost 73; packaged status 2; web 1288.
- bun.lock: regenerated lock byte-identical (`acce801629d359c0eadcbd7db1cfbfc568391adffa61424642b44105be835a2b`); no lock commit.

## Run 14 — 2026-11-26 — upstream 75fed1715b → 040f204a61

Status: **COMPLETE — merged, gated (GitHub Actions), pushed.** Branch `selfhost-homelab-up-20261126-2`;
merge `91c5e3ed51a7db7acd0b1f752b39559c5d00cf87` (first parent `e0f79ef9ffa2caa7eac3843d421eea78ad70fd1c`, the
selfhost tip = run 13 close + PATCHES #21; second parent `040f204a61b1b1d85a3b6b849a3bdd2e1edc6a97`), gated head
`d985c82375df1770ff63ce1336c887eeb039eb2b`. Not deployed.

- Incoming range: 2 commits, 54 files; a billing fix for an ended no-card trial (#3062) and the iPhone app prompt
  in the web shell and landing (#3061; `iosPromptUser` yields none without a Clerk user, so selfhost sessions
  never see the card). package.json changes in apps/web, packages/domain, packages/views.
- Mirror: fork `main` fast-forwarded `75fed1715b246a5760ec5eaca715aaa6ed2af887` →
  `040f204a61b1b1d85a3b6b849a3bdd2e1edc6a97`; read back on origin.
- Merge `91c5e3ed51`: auto-merged, 0 conflicts, no markers. Overlap with the fork delta = 6 files
  (`apps/web/src/lab/registry.ts`, `main.ts`, `shell/model.ts`, `shell/view-sidebar.ts`, `update.ts`, `bun.lock`);
  survival sweep over them: zero MISSING lines, no missing files. Upstream's lab entry, prompt flags and sidebar
  call sit beside the fork's Proxmox/Atlas lab entries, integration flags, OIDC sign-in and selfhost identity lines.
- Nothing in the range touches `packages/auth`, `packages/backend/src/platform/{Env,bindings}.ts`,
  `apps/api/src/worker/bindings.ts`, `apps/electric-sync/src/config.ts`, `apps/status` or `apps/selfhost`: no port
  to mirror, and the status adapter contract is unchanged.
- Gate fix of ours: the first Actions run (https://github.com/NevrLabs/maple/actions/runs/45883150371, head
  `91c5e3ed51`) failed in the image-parity step with exit 127. `apps/selfhost/dev/build-images.sh` defaulted `BUN` to
  `~/.bun/bin/bun`, which the GitHub runner (mise, bun on PATH) does not have; runs 3–13 never met it because they
  gated on the MacBook. The script now takes `bun` from PATH first and keeps `~/.bun` as the fallback
  (`d985c82375`, one line). The merge commit is unchanged.
- Gates: fork Actions accepted the dispatch (first GitHub-gated run since run 2). Green run
  https://github.com/NevrLabs/maple/actions/runs/45883547886 at `d985c82375`, dispatch headSha equal to the branch
  head. SDK, Docker-free bundles, eight typechecks and all suites green: QE integrations 512; backend org/Cloudflare
  607 passed / 1 skipped; warehouse 235 passed / 540 skipped; domain status 69; status-page 118; backend
  uptime/status 162; scraper 14; selfhost 73; packaged status 2; web 1291.
- bun.lock: the run's regenerated lock (artifact `bun-lock`) is byte-identical to the committed merged lock
  (`ee73665e3339dc81956eee7007d567f0cb22081685e9fde77cc0bc21fb84c429`); no lock commit.
## Run 15 — 2026-11-27 — upstream 040f204a61 → 167ca4f0a2

Status: **COMPLETE — merged, gated (GitHub Actions), pushed.** Branch `selfhost-homelab-up-20261127`;
merge `b338558657e309b271a46ae64c468c87abcae85f` (first parent `6f356297a6f437cd3b33a34a692c36612ae05300`,
the selfhost tip = run 14 close; second parent `167ca4f0a23266e94b99b2da6787ad866649d405`), gated head
`370e57214dc9ed0a1bdc20ecd6c0d7dcde291ab6` (merge + route table regeneration + gates extension). Not deployed.

- Incoming range: 3 commits, 128 files (+41.9k/−0.6k; 70 of the files are the new `apps/ios` on-call app,
  #3063): iOS on-call with pages, the schedule, widgets and a test page; the Kubernetes collector installed
  with Alchemy or Terraform from the install modal and the Connect-a-source snippets (#3071, pinned to one
  cluster by #3072); on-call paging over APNs (`Apns.ts`: single-flight provider-token cache, topic
  allowlist, background widget push); the mobile client as an audit actor; new on-call overview and widget
  on-call/pages endpoints. One new PG migration, `20261126154108_alert_member_notifications_user_idx`
  (`CREATE INDEX IF NOT EXISTS` on `alert_member_notifications (org_id, user_id)`: additive). No
  package.json or lock change.
- Mirror: fork `main` fast-forwarded `040f204a61b1b1d85a3b6b849a3bdd2e1edc6a97` →
  `167ca4f0a23266e94b99b2da6787ad866649d405`; read back on origin.
- Merge `b338558657` (separate worktree; the main checkout's uncommitted postgres-integration work untouched):
  1 conflict, resolved by hand. `apps/web/src/page/sources/kit/snippets.test.ts`: the fork's
  infrastructure-sender test and upstream's two Alchemy/Terraform snippet tests were both appended at the same
  EOF anchor; both kept. Auto-merged overlaps checked by token: `sources/kit/snippets.ts` keeps the
  Proxmox/Atlas/PostgreSQL snippet cases beside upstream's Alchemy/Terraform Kubernetes tabs; `lab/registry.ts`
  keeps `/lab/proxmox`, `/lab/atlas`, `/lab/postgres` and `/lab/bench/ui-lag` beside upstream's new
  `/lab/install-modal`.
- Survival sweep (`040f204a61` → `6f356297a6`): 3 overlap files, zero MISSING lines, no missing files.
- Wire surfaces: nothing in the range touches `packages/auth`, `packages/backend/src/platform/{Env,bindings}.ts`,
  `apps/api/src/worker/bindings.ts`, `apps/electric-sync/src/config.ts`, `apps/status` or `apps/selfhost`.
  `MobilePushService.layer` (new in the API service graph) needs only `ApnsClient` (plain HTTP client plus the
  already-ported `APNS_PRIVATE_KEY` secret; unconfigured = no-op), `LiveActivitiesService`,
  `MobileDevicesService` and `OrgMembershipService`: no port to mirror. Session format and the status adapter
  contract are unchanged.
- Post-merge `370e57214d` (not a text conflict): the viewer route table regenerated on the MacBook from the
  merged tree (706 → 711 routes: `oncallOverview.retrieve`, `widgetOnCall.retrieve`, `widgetPages.list`,
  `widgetPages.acknowledge`, `mobileDevices.testPage`); the two new POST routes are not allowlisted, so viewers
  stay refused. Gates extended: `apps/web/src/page/sources/kit` (this run's conflict surface, previously
  ungated) joins the web merge-surfaces suite in `gates.yml` and `scripts/mac-gates.sh`.
- Gates: fork Actions accepted the dispatch. Green run
  https://github.com/NevrLabs/maple/actions/runs/45926789762 at `370e57214d`, dispatch headSha equal to the
  branch head (checked at queue time and on the completed run). SDK, Docker-free bundles, eight typechecks and
  all suites green: QE integrations 512; backend org/Cloudflare 607 passed / 1 skipped; warehouse 235 passed /
  540 skipped; domain status 69; status-page 118; backend uptime/status 162; scraper 14; selfhost 73; packaged
  status 2; web 1300.
- bun.lock: the run's regenerated lock (artifact `bun-lock`) is byte-identical to the committed merged lock
  (`ee73665e3339dc81956eee7007d567f0cb22081685e9fde77cc0bc21fb84c429`); no lock commit.

## Feature — 2026-11-27 — MongoDB Atlas: clusters by project on `/infra/atlas` (PATCHES #18) and a Cloud cost provider (PATCHES #23)

Status: **COMPLETE — merged, gated (GitHub Actions), pushed. Not deployed.** Branch `selfhost-homelab-up-20261127-2`
from the run-15 docs tip `5ad30c5f2e04084213f8a082a4ffa4c8d6f4ff43`: `selfhost-mongodb-cost` (`beb2e69cca`) merged
--no-ff as `17ae71d272`, `selfhost-atlas-hierarchy` (`c13320db10`, the Atlas page rewrite that had sat uncommitted on
`e0f79ef9ff`, rebased onto the same tip) as `9960786cdc`; gates extension `7e185df97a`; lab fixture fix `75e783f7fc`
= gated head.

- Cost provider (PATCHES #23): an org pastes an Atlas service account (`<clientId> <clientSecret>`); the API checks
  it with Atlas, seals it in `cost_connections` and makes the `cost_sources` row (`PUT/DELETE /internal/cost/mongodb`,
  `mongodbCost.set/remove`; route table 711 → 713, both refused for viewers by the default non-GET rule). The sync
  reads the Admin API v2 (`orgs`, `invoices`, `invoices/:id/lineItems:search`; one token per source cached an hour,
  a retired token replaced once) into `cost_daily`: one row per usage day × `<project>/<cluster>` × SKU, cents as
  USD, the newest two days `estimated`; 12-month history, `lagDays: 1`. No DB migration (`provider` is plain text).
  Web: MongoDB Atlas in the Add-a-source cloud group, replace/remove like the other credential providers.
- Atlas page (PATCHES #18 rewritten): cluster table by project (members up, primaries, connections, ops/s, queue)
  and one member table per cluster; a cluster is healthy when every member reports in its set and every replica set
  has exactly one live primary. Lab: `/lab/atlas?state=live|multi|offline|empty|loading`.
- Gates: the web merge-surfaces suite now also runs `src/page/cost`, `src/page/infra-integrations/atlas` and `src/lab`
  (`gates.yml` and the skill's `scripts/mac-gates.sh`). First dispatch 45983182968 failed on that new suite only:
  `cost-fixture.test.ts` iterates every credential provider and the synced lab scenario lacked the new source;
  fixed in `75e783f7fc`. Green run https://github.com/NevrLabs/maple/actions/runs/45984095344 at `75e783f7fc`,
  headSha equal to the branch head (queue time and completed run). QE integrations 512; backend org/Cloudflare
  607 passed / 1 skipped; warehouse 235 / 540 skipped; domain status 69; status-page 118; backend uptime/status
  162; scraper 14; selfhost 73; packaged status 2; web 1582 (130 files).
- Before dispatch (MacBook): backend cost suite 457/457 (new: provider 6, connection service 6, normalize 4),
  web cost + atlas + lab 185/185, atlas/shell/route/view.lazy 538/538; typecheck domain, backend, web green
  (`apps/api` reports only the pre-existing `@maple-dev/alchemy/telemetry` module error in `worker-telemetry.ts`);
  oxlint clean on every touched file; oxfmt clean on the cost files (the three Atlas-side files oxfmt would rewrap
  are pre-existing upstream lines, left alone).
- bun.lock: the run's artifact is byte-identical to the committed lock (`ee73665e3339dc81956eee7007d567f0cb22081685e9fde77cc0bc21fb84c429`); no lock commit.
- Deployment: owner gate, both targets. The alerting container needs egress to `cloud.mongodb.com` only once a
  source is saved; the API needs it when the credential is checked.

## Deploy — 2026-11-27T11:32Z — feature line @ `75e783f7fc` on CT130 (owner go)

CT130 api, alerting, scraper, electric-sync, migrate and web run `up-75e783f7` (selfhost `sha256:c0b4b5314f88…`,
web `sha256:e2c6f55e1c69…`; built on the MacBook colima, linux/amd64, ledger `~/ci/maple-images/up-75e783f7/`;
streamed MacBook → talos → CT130 `docker load`, loaded IDs equal to the builder's). Replaces `up-c8295a73` (api set,
run 11) and `up-8ee1fcc5` (web). status stays `status-07818b05`; ingest/collector stay `up-593f6100`; postgres,
electric, proxy and cloudflared untouched (container IDs and StartedAt unchanged). Writers stopped 11:31:16–11:32:08Z.
- Preflight: Setup Health 36 pass / 10 fail with exactly the accepted IDs (2026-11-19 baseline); no count growth.
- Backups: PBS `ct/130/2026-11-27T11:27:52Z` on pbs-deepvault (11.49 GB, rc 0); quiesced `pg_dump -Fc`
  sha256 `3a5793378964721164a42c2711b980b57bef7f68e0f551366656246be22b67c1` in
  `/opt/maple/backups/feature-75e783f7-20261127T111324Z/`.
- Rehearsal on CT130 (hot dump → scratch `postgres:17-alpine` → the candidate `migrate.js`): 212 → 239 PG
  migrations, 154 tables. Live `migrate`: the same 27, plus 7 ClickHouse migrations from runs 12–15
  (`cli.js apply`: "7 migrations and 0 features applied"). The CH delta was not rehearsed: it was looked for in
  `packages/clickhouse-cli` only and reported empty; the compose `migrate` applied them without error.
- Post: `/_api/health` 200; `DELETE /_api/internal/cost/mongodb` 401 (route present, refused without a session);
  0 restarts; Setup Health 36/10, same IDs (STAT-02 at 2 services, within the accepted count). Ingest logged six
  `Collector forwarding failed` lines in the two seconds after its restart and none since. Two `traefik` error
  incidents opened at 11:31:27Z (the stop window) and resolved; the open `hermes-gateway` incident predates this.
- Rollback (images only; the PG migrations are not reversed — additive but `drop_morph_spend_readings`):
  restore `compose.override.pre-feature.yaml` from the backup dir, then
  `docker compose up -d --no-deps --pull never --force-recreate api alerting scraper electric-sync migrate web`.
- Not applied on CT130: PATCHES #21 compose/retention files (`compose.yaml`, `ch-retention` SQL) and the
  ingest/collector changes of runs 12–15.

## Merge — 2026-11-27 — `selfhost-aws-cost-credits` (PATCHES #22) absorbed into the selfhost line

`89c696f059` merges the branch that Noovoleum runs as `33170901` (AWS Cloud Cost gross usage, credits as rows of
their own) so the next Noovoleum upgrade keeps it; the MongoDB Atlas cost provider is PATCHES #23 from here on.
Gates green https://github.com/NevrLabs/maple/actions/runs/45989895573 at `89c696f059`. Not deployed.
