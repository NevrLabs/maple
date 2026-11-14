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
| #17 capability-denied CF datasets | https://github.com/MapleTechLabs/maple/pull/2499 | `pr/cloudflare-capability-denied` `1656567f0` | green 43048191135 |
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
