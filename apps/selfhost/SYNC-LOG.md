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
| #15 first-mount sparkline sizing | https://github.com/MapleTechLabs/maple/pull/2498 | `pr/sparkline-first-mount-height` `5ed2676c5` | green 43048183588 |
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
