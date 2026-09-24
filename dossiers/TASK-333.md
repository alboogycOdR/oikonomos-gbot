# TASK-333 dossier

**Brief:** Read markers and pins for threads (backend)

**Assigned:** CX9. **Depends on:** TASK-331.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log
- [2026-09-24T12:15:00Z] [CX9] Started fresh on `task/TASK-333-cx9`. Preflight output: `034_thread_read_markers.up.sql` NEW (migration parent exists); `034_thread_read_markers.down.sql` NEW (migration parent exists); `packages/db/src/threads.ts` FILE (329 lines); `packages/db/src/threads.test.ts` FILE (327 lines); `packages/db/src/index.ts` FILE (350 lines); `services/control-api/src/app.ts` FILE (2898 lines); `services/control-api/src/ports.ts` FILE (1195 lines); `services/control-api/src/openapi.ts` FILE (770 lines); `services/control-api/src/threadReadMarkers.routes.test.ts` NEW (source parent exists). No review findings present; next: trace authenticated identity and thread/message persistence before implementation.
- [2026-09-24T13:35:00Z] [CX9] Implemented tenant-keyed viewer state because authenticated requests expose only `tenantId` (the Firebase UID), never a separate user principal. Added migration 034 (idempotent up/down/up), DB cursor/pin operations and roster unread/pin projection, protected read/pin routes, OpenAPI, and focused DB/route tests. Verification: `pnpm --filter @oikonomos/db typecheck`, `pnpm --filter @oikonomos/db build`, and `pnpm --filter @oikonomos/control-api typecheck` pass; isolated DB suite: 46 files, 292 passed, 2 skipped; isolated control-api suite includes the new routes and passes when run alone. Recursive isolated suite reports the same three baseline external failures captured in `_branch_full.log`: evals-harness, worker, and control-api's TASK-121 FreeLLMAPI group-route assertion (400 vs 201). No TASK-333-owned test failure.
