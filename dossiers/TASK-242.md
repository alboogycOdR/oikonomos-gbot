# TASK-242 — Workspace-1 — run completion receipt API: GET /runs/:id/receipt

**Unit:** CX9 · **Priority:** medium · **Depends_On:** TASK-238

## Brief
A read-only projection over what already exists per run: final bot message (`messages` where `run_id` = id, role `bot`, newest), audit actions (`audit_events` for the run: capability, tier, verdict, reason), approvals used (`approvals` for the run with status), spend (`spend_records` for the run: sum `cost_usd`, tokens, or `unavailable` when no rows), unresolved approvals (`status='pending'`), and run status/timestamps. Tenant-scoped through the run's task; 404-never-403. Query in `packages/db/src/runReceipt.ts`, port on `ChatDependencies`, route + OpenAPI in `app.ts`. Spend must state `actual` when rows exist and `unavailable` otherwise — never estimated. Do not touch `chatRunDriver.ts` (the failure-path `spend.unrecorded` marker, §7.4, is folded into TASK-244 which owns that file). Sequenced after TASK-238 (same owner, `ports.ts`/`app.ts`).

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §7.1; ORCH_REVIEW/DISPOSITION_MATRIX.md row F4; ADR-004

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
A read-only projection over what already exists per run: final bot message (`messages` where `run_id` = id, role `bot`, newest), audit actions (`audit_events` for the run: capability, tier, verdict, reason), approvals used (`approvals` for the run with status), spend (`spend_records` for the run: sum `cost_usd`, tokens, or `unavailable` when no rows), unresolved approvals (`status='pending'`), and run status/timestamps. Tenant-scoped through the run's task; 404-never-403. Query in `packages/db/src/runReceipt.ts`, port on `ChatDependencies`, route + OpenAPI in `app.ts`. Spend must state `actual` when rows exist and `unavailable` otherwise — never estimated. Do not touch `chatRunDriver.ts` (the failure-path `spend.unrecorded` marker, §7.4, is folded into TASK-244 which owns that file). Sequenced after TASK-238 (same owner, `ports.ts`/`app.ts`).

## Owned_Paths
services/control-api/src/app.ts, services/control-api/src/openapi.ts, services/control-api/src/ports.ts, services/control-api/src/receipt.routes.test.ts, packages/db/src/runReceipt.ts, packages/db/src/runReceipt.test.ts, packages/db/src/index.ts

## Work Log

- [2026-09-12T12:20:00Z] [CX9] Resumed claimed task on new `task/TASK-242-cx9` branch. Reviewed TASK-242 (Review_Findings: none), Workspace Wave §§1, 7.1 and 10, disposition F4, and ADR-004. Preflight output: `services/control-api/src/app.ts` FILE (2560 lines); `openapi.ts` FILE (537); `ports.ts` FILE (848); `receipt.routes.test.ts` NEW; `packages/db/src/runReceipt.ts` NEW; `runReceipt.test.ts` NEW; `index.ts` FILE (230). Implementing a read-only DB projection and tenant-checked API route only within Owned_Paths.
- [2026-09-12T14:01:00Z] [CX9] Added `getRunReceipt`: ownership joins `runs` to the task tenant, queries final bot output, audit payload verdict/reason, all approvals plus pending subset, and only reports actual spend when ledger rows exist. Added port/composition wiring, route, OpenAPI, and unit + real-Postgres tests. Targeted isolated tests pass: `pnpm --filter @oikonomos/db exec vitest run src/runReceipt.test.ts` (3/3), `pnpm --filter @oikonomos/control-api exec vitest run src/receipt.routes.test.ts` (1/1); DB and control-api typechecks pass. Serial full isolated workspace suite is running via `scripts/test-isolated.ps1`.
