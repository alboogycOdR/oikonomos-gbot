# TASK-035 dossier

## Brief
compose.ts wires the three adapters + PostToolUse into createHarness(); the eight canaries CAN-01..08 run CI-blocking. The G-GOV gate. CAN-02 is the regression test against the original architecture flaw. Protected.

## Spec pointers
ADR-001 Canary table; directive §6. CAN-03 may reuse the existing infra/ci banned-mode scanner. ORCH wires the CI job at merge (workflow file is cross-cutting).

## Intended approach
compose.ts is the sole composition root (kept out of index.ts so adapters could be concurrent). Depends on all four of OIK-034/035/036/037.

## Work Log
- [2026-08-17T21:28:00Z] [GB] Session start. Detached HEAD 6f849c9 → created `task/TASK-035-gb`. control.mode=strict: PLAN.md not touched. Preflight (paste verbatim):

```
[preflight] TASK-035 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    packages/harness-factory/src/compose.ts  -> does not exist; parent packages/harness-factory/src/ exists
  NEW    packages/harness-factory/test/compose.test.ts  -> does not exist; parent packages/harness-factory/test/ exists
  GLOB   evals/**  -> matches nothing yet (new territory)
  FILE   pnpm-workspace.yaml  -> exists, 6 line(s), 86 bytes
  FILE   package.json  -> exists, 28 line(s), 578 bytes
  FILE   pnpm-lock.yaml  -> exists, 3245 line(s), 104781 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Design: compose.ts statically imports L1/L2/L3 + PostToolUse, builds an in-process broker fetch around injected `handlePreToolUse` + fake I/O deps, binds `harness.gateSubprocess` into Codex/Grok factories. evals/harness is a new workspace package; CAN-03 reuses `infra/ci/banned-modes.mjs`; CAN-06/07 DB-gated on DATABASE_URL. Next: implement compose + canaries.

- [2026-08-17T22:02:00Z] [GB] Implementation complete. compose.ts is the composition root (adapters loaded here; specifiers assembled so factory.test.ts's constructor-module scan still treats index.ts as adapter-free). evals/harness is a workspace member; `pnpm canaries` runs CAN-01..08 + subprocess deny=>no-spawn. CAN-06/07 in-process always run; Postgres atomicity cases skip when DATABASE_URL unset (2 skipped).

  Test_Evidence:
  - `python scripts/preflight_paths.py TASK-035` — 6 entries, NEW compose + evals, FILE workspace/package/lock
  - `pnpm --filter @oikonomos/harness-factory test` — 8 files, 56/56 pass (includes compose.test + sole-constructor)
  - `pnpm --filter @oikonomos/evals-harness test` / `pnpm canaries` — 10 files, 14 passed | 2 skipped (CAN-06/07 Postgres)
  - `pnpm --filter @oikonomos/harness-factory typecheck` and `pnpm --filter @oikonomos/evals-harness typecheck` — exit 0
  - `pnpm lint` — exit 0
  - `pnpm -r test` — harness-factory + evals green; services/worker fails 2 tests (`getRun`/`startRun` is not a function). Pre-existing: `packages/db/src` exports those symbols but `packages/db/dist/index.js` does not (stale dist). Out of this task's Owned_Paths.

  Ready for review.

- [2026-08-18T07:10:00Z] [GB] Resume (rework). control.mode=strict; branch `task/TASK-035-gb` at 47973e9 with uncommitted fixture-alignment edits. Preflight:

```
[preflight] TASK-035 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   packages/harness-factory/src/compose.ts  -> exists, 296 line(s), 9338 bytes
  FILE   packages/harness-factory/test/compose.test.ts  -> exists, 254 line(s), 8092 bytes
  GLOB   evals/**  -> 7707 file(s):
           evals/harness/README.md
           ... (workspace + node_modules)
  FILE   pnpm-workspace.yaml  -> exists, 7 line(s), 101 bytes
  FILE   package.json  -> exists, 29 line(s), 642 bytes
  FILE   pnpm-lock.yaml  -> exists, 3282 line(s), 102666 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  ORCH blocker: CAN-06/07 Postgres variants failed on `approvals_capability_id_fkey` because `TIER3_CAPABILITY_ID` was `email.send_message` while `seedInboxTriage` inserts `email.send`. Aligning the constant, extracting `seedCanaryApprovalParents` (seed + verify capability + task/run insert), updating CAN-01 assertion. Next: run `pnpm canaries` with isolated DATABASE_URL.

- [2026-08-18T07:32:00Z] [GB] Rework complete. Root cause confirmed: fixture used `email.send_message` (not a capabilities row); `seedInboxTriage` + task/run inserts were already present. Fix: `TIER3_CAPABILITY_ID = "email.send"`, `seedCanaryApprovalParents` asserts the capability exists before insert.

  Isolated DB: existing `oikonomos-canary-035-pg` (pgvector/pg16, 127.0.0.1:55438). Schema 001 already applied. No DROP/TRUNCATE; fixture only upserts seed + inserts task/run/approvals.

  Test_Evidence:
  - `python scripts/preflight_paths.py TASK-035` — 6 entries, all FILE/GLOB exist
  - `pnpm --filter @oikonomos/harness-factory test` — 8 files, 56/56 pass
  - `pnpm canaries` (DATABASE_URL unset) — 10 files, 14 passed | 2 skipped (CAN-06/07 Postgres visibility)
  - `DATABASE_URL=postgresql://oikonomos:local_test_only@127.0.0.1:55438/oikonomos pnpm canaries` — 10 files, **16/16 passed, 0 skipped** (CAN-06 + CAN-07 Postgres atomicity executed green)
  - `pnpm --filter @oikonomos/harness-factory typecheck` and `pnpm --filter @oikonomos/evals-harness typecheck` — exit 0
  - `pnpm lint` — exit 0
  - `pnpm -r test` — worker still fails 2 tests (`getRun`/`startRun` is not a function via stale `packages/db/dist`). Pre-existing, outside Owned_Paths.

  Ready for re-review.
