# TASK-134 dossier

## Work Log

- [2026-09-04T17:05:00Z] [CX] Preflight completed against the dispatcher's live PLAN.md:

  ```text
  [preflight] TASK-134 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 7 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/control-api/src/app.ts  -> exists, 982 line(s), 37822 bytes
    FILE   services/control-api/src/ports.ts  -> exists, 165 line(s), 7239 bytes
    GLOB   services/control-api/src/**/*.test.ts  -> 3 file(s):
             services/control-api/src/auth.test.ts
             services/control-api/src/chat.routes.test.ts
             services/control-api/src/sse.test.ts
    FILE   apps/dashboard/src/pages/ChatPage.tsx  -> exists, 272 line(s), 9627 bytes
    FILE   apps/dashboard/src/pages/ChatPage.test.tsx  -> exists, 353 line(s), 13919 bytes
    FILE   services/worker/package.json  -> exists, 42 line(s), 1138 bytes
    FILE   pnpm-lock.yaml  -> exists, 5096 line(s), 169722 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-04T17:05:00Z] [CX] Blocked before source changes: TASK-134 requires `cron-parser` as a direct dependency of `services/control-api`, because the create-routine handler is in `services/control-api/src/app.ts`. Its manifest, `services/control-api/package.json`, is not an Owned_Path; the listed `services/worker/package.json` cannot satisfy direct dependency resolution for the control-api package. Need ORCH to add `services/control-api/package.json` to Owned_Paths (or explicitly revise the direct-dependency requirement).

- [2026-09-04T17:12:00Z] [CX] Resume preflight found a sync mismatch: the dispatcher-provided live TASK-134 block grants `services/control-api/package.json`, but `python scripts/preflight_paths.py TASK-134` in this worktree still reports the older `services/worker/package.json` grant. The required direct dependency belongs in the control-api manifest, so no source edits were made. Next: synchronize this worktree's task metadata with the corrected main PLAN.md, then rerun preflight and proceed.

- [2026-09-04T17:23:00Z] [CX] Resumed on `task/TASK-134-cx`; fresh preflight now confirms the corrected `services/control-api/package.json` grant. Read the OIK-109 task block, WBS E11, existing control-api route/port patterns, dashboard ChatPage/RightPanel tree, and live `packages/db/src/routines.ts`. Blocked before implementation: `createRoutine` has no `nextFireAt` input and its INSERT does not write `role_routines.next_fire_at`. The sole existing writer, `recordRoutineFire`, necessarily changes `last_fire_status` (and for `queued`, `last_fire_at`), so calling it at creation would falsely record a fire. Meeting AC1 requires an additive DB accessor/input extension in `packages/db/src/routines.ts` (and likely its test), neither of which is in TASK-134 Owned_Paths. Next: ORCH must grant that exact DB path or provide an existing state-neutral setter/creation API.

- [2026-09-04T15:15:40Z] [CX] Completed OIK-109 implementation after refreshing this worktree from the control checkout (preflight then confirmed the 9-path grant). `POST /roles/:roleId/routines` validates exactly five cron fields using direct `cron-parser`, persists its computed initial `next_fire_at` through an additive, state-neutral `NewRoutine.nextFireAt`, and `GET` returns role-scoped rows. `ChatPage` loads the active bot's routines and supplies the existing Routines tab. Tests: control-api 132/132 (including real Postgres endpoint create/list), db 131/131 with 2 skipped, dashboard 84/84; `pnpm lint` green. `pnpm -r build` is blocked outside territory by worker's unresolved `@oikonomos/workspace` import; retrying `pnpm --filter @oikonomos/worker build` reproduces it. `pnpm -r test` has one unrelated shared-Postgres concurrent DDL deadlock in `packages/db/src/roles.test.ts` (TASK-084 backfill guard); the same db and control-api suites pass in isolation.
