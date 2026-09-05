# TASK-156 — Role instructions/persona

## Work Log

- [2026-09-05T11:15:00Z] [CX] Preflight completed before implementation:

  ```text
  [preflight] TASK-156 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 9 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   infra/postgres/migrations/**  -> 20 file(s):
             infra/postgres/migrations/001_schema_v1.down.sql
             infra/postgres/migrations/001_schema_v1.up.sql
             infra/postgres/migrations/002_approval_binding.down.sql
             infra/postgres/migrations/002_approval_binding.up.sql
             infra/postgres/migrations/003_intake_nonces.down.sql
             infra/postgres/migrations/003_intake_nonces.up.sql
             infra/postgres/migrations/004_roles_routines_rules.down.sql
             infra/postgres/migrations/004_roles_routines_rules.up.sql
             infra/postgres/migrations/005_agent_memory.down.sql
             infra/postgres/migrations/005_agent_memory.up.sql
             infra/postgres/migrations/006_memory_acl_versioning.down.sql
             infra/postgres/migrations/006_memory_acl_versioning.up.sql
             ... and 8 more
    FILE   packages/db/src/roles.ts  -> exists, 235 line(s), 7467 bytes
    FILE   packages/db/src/roles.test.ts  -> exists, 227 line(s), 10271 bytes
    FILE   packages/db/src/index.ts  -> exists, 145 line(s), 3095 bytes
    FILE   services/control-api/src/app.ts  -> exists, 1088 line(s), 41826 bytes
    FILE   services/control-api/src/ports.ts  -> exists, 241 line(s), 10875 bytes
    GLOB   services/control-api/src/*.test.ts  -> 5 file(s):
             services/control-api/src/auth.test.ts
             services/control-api/src/chat.routes.test.ts
             services/control-api/src/ports.test.ts
             services/control-api/src/pushTransport.test.ts
             services/control-api/src/sse.test.ts
    FILE   services/worker/src/chatRunDriver.ts  -> exists, 492 line(s), 24212 bytes
    FILE   services/worker/src/chatRunDriver.test.ts  -> exists, 914 line(s), 49073 bytes
  ```

- [2026-09-05T11:25:00Z] [CX] Added additive migration 011, nullable `Role.instructions`, DB update helper, authenticated PATCH route, and system-prompt construction. The driver always supplies a non-empty role identity prompt and appends custom instructions when configured; existing cwd/env/resume options remain on the same SDK options object.
- [2026-09-05T11:28:00Z] [CX] Applied only the additive TASK-156 migration to the development Postgres instance for real-schema verification. Focused tests passed: DB roles 10/10; control API instruction-route tests 2/2; worker system-prompt tests 2/2.
- [2026-09-05T11:30:00Z] [CX] Full affected suites passed: `pnpm --filter @oikonomos/db test` (28 files, 140 passed, 2 skipped); `pnpm --filter @oikonomos/control-api test` (10 files, 145 passed); `pnpm --filter @oikonomos/worker test` (13 files, 70 passed, 1 skipped).
- [2026-09-05T11:32:00Z] [CX] Repository gates passed: `pnpm -r test` exit 0; `pnpm -r build` exit 0; `pnpm lint` exit 0.
