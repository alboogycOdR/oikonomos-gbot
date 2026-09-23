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
