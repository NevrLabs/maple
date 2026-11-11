# Upstream sync log — NevrLabs/maple selfhost fork

One section per sync run, newest last. Fork line: `selfhost-homelab-*` branches carry the
selfhost patches (catalogue: `apps/selfhost/PATCHES.md`); `main` tracks upstream as a mirror.

## Run 1 — 2026-11-11 — upstream e231894bc → current upstream/main

Status: **IN PROGRESS**

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
  2. [ ] Mirror: fast-forward fork `main` → upstream/main
  3. [ ] Candidate branch `selfhost-homelab-up-20261111` from `fd23f5f06`, merge upstream/main
  4. [ ] Conflict resolution against PATCHES #1–#17 (preserve numbering; no patch superseded
        without verification)
  5. [ ] Gates on fxbuilder/fxcompute-01 (never on Zephyr): install, typecheck, backend +
        affected suites
  6. [ ] Push candidate + PATCHES.md/SYNC-LOG updates
  7. [ ] Report
- Out of scope this run (separate owner gates): image builds, CT130 deployment, pod-memory
  and noovoleum-images branch rebases.
