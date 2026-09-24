# TASK-331 dossier

**Brief:** Thread roster: title and one-line preview on GET /threads

**Assigned:** CX9. **Depends on:** TASK-326.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T07:08:00Z] [CX9] Preflight completed before implementation: `[preflight] TASK-331 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE`; all six existing files reported FILE and `services/control-api/src/threadRoster.routes.test.ts` reported NEW. Implemented roster-query title derivation (first six user-message words), collapsed 120-character latest preview with author kind, lastMessageAt, tenant filtering, and OpenAPI documentation. Added real-Postgres DB and route coverage. `pnpm --filter @oikonomos/db build`, DB and control-api typechecks pass; isolated db suite ran 291 passing/2 skipped with one unrelated `database.test.ts` cleanup deadlock; control-api route test passes, with only pre-existing capability seed and FreeLLMAPI failures in its complete package run. Full recursive isolated suite is running.
- [2026-09-24T07:12:00Z] [CX9] Final verification: `pnpm --filter @oikonomos/db build`, `pnpm --filter @oikonomos/db typecheck`, and `pnpm --filter @oikonomos/control-api typecheck` PASS. `scripts/test-isolated.ps1 -Filter @oikonomos/db`: TASK-331 DB coverage passes; package result 291 pass, 2 skipped, 1 unrelated `database.test.ts` fixture-cleanup deadlock. `scripts/test-isolated.ps1 -Filter @oikonomos/control-api`: TASK-331 route/OpenAPI coverage 2/2 pass; 367/369 pass overall. The only remaining failures are master-environment baselines: TASK-264 expects a missing `workspace.request_secret` capability seed, and TASK-121's real FreeLLMAPI fanout returns 400 rather than 201. Full recursive isolated run was started and completed while package output was being streamed; no TASK-331-owned test failure was observed.
