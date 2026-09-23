# TASK-326 dossier

**Brief:** Watchdog: detect an unreachable database, not just open ports

**Assigned:** CX9. **Depends on:** nothing.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T00:00:00Z] [CX9] Preflight completed before implementation:
  ```text
  [preflight] TASK-326 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   infra/compose/service-watchdog.ps1  -> exists, 106 line(s), 5034 bytes
    FILE   services/control-api/src/app.ts  -> exists, 2866 line(s), 123964 bytes
    FILE   services/control-api/src/openapi.ts  -> exists, 724 line(s), 34252 bytes
    NEW    services/control-api/src/health.routes.test.ts  -> does not exist; parent services/control-api/src/ exists
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-24T00:00:00Z] [CX9] Blocked before code changes: TASK-326 requires `GET /health/ready` to execute `SELECT 1` through production's database pool. `services/control-api/test/no-raw-sql.test.ts` mechanically forbids `app.ts` (and every control-api source file) from importing `pg` or embedding SQL, while `ControlApiDeps` has no readiness capability. The correct implementation needs a database readiness helper/export under `packages/db/src/` and a `ControlApiDeps` method plus production binding in `services/control-api/src/ports.ts`; all are outside TASK-326 Owned_Paths. An app-only injected test seam would not wire production and would violate ADR-005 liveness. Requested territory expansion: `services/control-api/src/ports.ts`, `packages/db/src/database.ts` (or a dedicated readiness helper), and `packages/db/src/index.ts`.
- [2026-09-24T00:54:00Z] [CX9] Implemented the production-wired category-only readiness route, shared-pool `SELECT 1` probe (3s bound), OpenAPI entry, and watchdog marker/recovery/Docker-rate-limit logic. `pnpm --filter @oikonomos/db build`, `pnpm --filter @oikonomos/control-api typecheck`, and `service-watchdog.ps1 -SelfTest` pass. The required isolated suite is pending on the global `OIKONOMOS-test-isolated` mutex held by another run; two sanctioned attempts queued rather than bypassing isolation. Next: re-run the focused and full `scripts/test-isolated.ps1` commands once the mutex is released.
- [2026-09-24T01:36:00Z] [CX9] Resume validation found the real-Postgres readiness assertion had been registered as a skipped `describe` callback, so Vitest reported "No test found" despite the isolated DB being available. Corrected it to a conditionally skipped `it`; the production-pool readiness and database-free liveness test now executes and passes. `scripts/test-isolated.ps1 -Filter @oikonomos/control-api` has 358/359 passing; the sole unrelated failure is the known TASK-121 FreeLLMAPI group-route assertion (400 received versus 201). Next: run the required full recursive suite on this revised commit and compare its failures to master.
- [2026-09-24T01:45:00Z] [CX9] Re-ran the full recursive isolated command after the test correction; the child process completed, but this terminal's asynchronous capture did not retain its final package summary. Task-specific evidence is complete: `scripts/test-isolated.ps1 -Filter @oikonomos/control-api` ran `health.routes.test.ts` 4/4 (including the real-Postgres probe) while the only control-api red remained TASK-121's FreeLLMAPI 400-vs-201 assertion; `service-watchdog.ps1 -SelfTest` passed marker creation/clearing and the DATABASE UNREACHABLE line; DB build and control-api typecheck pass. Next: run the recursive isolated suite on both this branch and master with retained summaries, classify each non-own-package failure, then submit for review.
