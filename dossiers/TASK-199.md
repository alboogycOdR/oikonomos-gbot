# TASK-199 Work Log

- [2026-09-06T22:31:35Z] [GB] Resumed dispatcher-claimed branch `task/TASK-199-gb` (already checked out; `git rev-parse --verify` → `010f0c2e744358e2e6f69bb17d90ab9eb54c7727`, then ff-only to `origin/master` `fc12b06`). Review_Findings empty — greenfield, not rework. Preflight (verbatim):

```
[preflight] TASK-199 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
[preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   packages/db/src/database.ts  -> exists, 202 line(s), 6525 bytes
  GLOB   packages/db/src/*.ts (accessor pool-construction call sites only — do not touch query logic)  -> matches nothing yet (new territory)
  GLOB   packages/db/src/*.test.ts  -> 18 file(s):
           packages/db/src/capabilities.test.ts
           packages/db/src/database.test.ts
           packages/db/src/deviceTokens.test.ts
           packages/db/src/intakeNonces.test.ts
           packages/db/src/messages.test.ts
           packages/db/src/requireApprovalRules.test.ts
           packages/db/src/roleMessages.test.ts
           packages/db/src/roleSandboxes.test.ts
           packages/db/src/roles.test.ts
           packages/db/src/routines.test.ts
           packages/db/src/runs.test.ts
           packages/db/src/secretRequests.test.ts
           ... and 6 more
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  GLOB `packages/db/src/*.ts (...comment...)` reports NEW because PLAN.md's parenthetical is part of the glob string; the accessor files themselves exist (confirmed by listing `packages/db/src/`). Investigation: every accessor (`roles.ts`, `runs.ts`, `messages.ts`, `threads.ts`, `threadContext.ts`, `deviceTokens.ts`, `secretRequests.ts`, and the rest) has a local `withPool` that `new Pool({...defaultPoolConfig})` + `pool.end()` per call. `capabilities.ts` already accepts an injected `Pool` via `createConnectorRegistrationStore`. `Database` already owns one instance pool. Callers (`createDatabaseBackedDeps`, `index.ts`) pass `DatabaseOptions` and cannot be changed (out of territory), so the fix is a process-level shared pool keyed by `(connectionString, poolConfig)` used by every accessor `withPool`. `Database.close()` stays independent so broker `onClose` cannot kill the control-api accessor pool.

- [2026-09-06T22:40:00Z] [GB] Implemented `getSharedPool` / `withPool` / `closeSharedPools` in `database.ts`. Replaced every accessor-local `withPool` (18 files) with the shared helper; query SQL untouched. `capabilities.ts` left as injected-pool. Added `database.test.ts` identity + liveness source-scan (`new Pool(` forbidden outside `database.ts`). Test-only cleanup: `messages.test.ts` / `threadContext.test.ts` now delete `thread_members` before `threads` (same pattern as `threads.test.ts`) so leftover membership rows cannot fail fixture teardown.

- [2026-09-06T22:45:00Z] [GB] Verification. `pnpm --filter @oikonomos/db test`: 37 files, 186 passed / 2 skipped, exit 0. `src/database.test.ts` 10/10. `chat.routes.test.ts` isolation x3: no `sorry, too many clients already` in any run (AC2). Same file has a pre-existing TASK-121 timing assertion (`expected 'started' to be 'waiting_approval'` after a 1s poll of a detached chat driver) — out of territory, not the connection-burst failure. `pnpm lint` exit 0. `pnpm -r build` exit 0 (after `pnpm install` restored a missing `@oikonomos/sandbox-client` workspace link; lockfile unchanged). `pnpm -r test` fail-fasted on out-of-territory flakes: `packages/approvals` editApproval 5s timeout under parallel load (119/119 pass in isolation); `services/worker` pg-boss `lastFireStatus` queued vs missed (documented TASK-201) and `fs.read` default-tier drift. In-territory db suite green. Ready for needs_review.

