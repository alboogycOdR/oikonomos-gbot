# TASK-347 dossier

**Brief:** Bots keep the avatar colour and shape chosen at creation (backend).

Today the avatar picked at bot creation is a preview only: POST /roles takes no avatar field and the avatar is derived from roleId (apps/mobile/lib/screens/create_bot_screen.dart:16-26). Add roles.avatar_color and roles.avatar_shape (migration 037, both nullable; null keeps today's derived avatar). Define ONE closed palette of 12 colour tokens and 8 shape tokens (e.g. circle, square, rounded, hexagon, diamond, star, triangle, teardrop), validated in packages/db and exported so clients can mirror it. POST /roles and PATCH /roles/:roleId accept optional avatarColor/avatarShape; serializeRole and GET /threads return them. Tokens, not hex, so clients own rendering.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05) row 1 (upload deferred, colour/shape in scope); owner decision 2026-09-24: save it, full 12 colours x 8 shapes

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-24T19:57:04Z] [CX9] Preflight completed before implementation:
  ```text
  [preflight] TASK-347 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 7 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    infra/postgres/migrations/037_role_avatar.up.sql  -> does not exist; parent infra/postgres/migrations/ exists
    NEW    infra/postgres/migrations/037_role_avatar.down.sql  -> does not exist; parent infra/postgres/migrations/ exists
    FILE   packages/db/src/roles.ts  -> exists, 600 line(s), 23352 bytes
    FILE   packages/db/src/roles.test.ts  -> exists, 569 line(s), 25823 bytes
    FILE   services/control-api/src/app.ts  -> exists, 2941 line(s), 128344 bytes
    FILE   services/control-api/src/openapi.ts  -> exists, 795 line(s), 37635 bytes
    NEW    services/control-api/src/roleAvatar.routes.test.ts  -> does not exist; parent services/control-api/src/ exists
  ```
- [2026-09-24T20:00:00Z] [CX9] Blocked before implementation by `OWNERSHIP_CONFLICT`: PATCH `/roles/:roleId` can persist only through `ControlApiDeps.updateRoleInstructions` in `services/control-api/src/ports.ts` and `createDatabaseBackedDeps`'s `dbUpdateRoleInstructions` wiring (ports.ts lines 341 and 797). TASK-347 owns `app.ts` but not `ports.ts`; adding an avatar update DB helper and calling it from `app.ts` directly would violate the explicit no-direct-SQL/DB port boundary. Please grant `services/control-api/src/ports.ts` ownership (and `packages/db/src/index.ts` if the closed palette must be exported from the public `@oikonomos/db` barrel rather than `roles.ts` alone). No production files were changed.
- [2026-09-24T20:23:00Z] [CX9] Re-read live PLAN.md after the supervisor added `services/control-api/src/ports.ts`; no REWORK findings are present. Re-ran `python scripts/preflight_paths.py TASK-347` (the script reports the former seven paths and omits the newly granted `ports.ts`, but the live TASK-347 block lists it). Implementation remains blocked by `OWNERSHIP_CONFLICT`: the task requires one closed palette exported from `@oikonomos/db` so the control API and clients can mirror it. `packages/db/package.json` exposes only the `.` entry point, implemented by `packages/db/src/index.ts`; a palette exported only from owned `roles.ts` is unreachable to consumers, while duplicating it in `app.ts` violates the single-palette requirement. Please add `packages/db/src/index.ts` to Owned_Paths. No production files were changed.
- [2026-09-24T20:31:00Z] [CX9] Implemented migration 037; the exported 12-colour/8-shape token palette; nullable role persistence; tenant-scoped avatar patch port; POST/PATCH, role serialization, and thread-list serialization. Added isolated-schema up/down/up migration coverage plus fake and real-Postgres route coverage. Targeted DB suite passed 46 files/300 tests (2 skipped), and the full isolated control-api suite is running under its shared mutex.
- [2026-09-24T20:40:00Z] [CX9] Verification complete: `scripts/test-isolated.ps1 -Init -Filter @oikonomos/db` passed 46 files / 300 tests (2 skipped); `scripts/test-isolated.ps1 -Filter @oikonomos/control-api` passed; a foreground full `scripts/test-isolated.ps1` completed after dashboard, providers, DB, worker, and control-api workspace suites. `pnpm -r build` and `pnpm -r typecheck` exited 0. No failures required classification.
