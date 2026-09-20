# TASK-313 — Scope `workspace.retire_bot` to the acting manager's project roster

## Work Log

- [2026-09-20T19:00:00Z] [CX9] Preflight completed before edits:
  ```text
  [preflight] TASK-313 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/db/src/roles.ts  -> exists, 563 line(s), 21639 bytes
    FILE   packages/db/src/roles.test.ts  -> exists, 480 line(s), 21841 bytes
    FILE   services/worker/src/workspaceMcpServer.ts  -> exists, 298 line(s), 15898 bytes
    FILE   services/worker/src/workspaceMcpServer.test.ts  -> exists, 188 line(s), 10206 bytes
    FILE   services/worker/src/geminiToolExecutors.ts  -> exists, 866 line(s), 42354 bytes
    FILE   services/worker/src/geminiToolExecutors.test.ts  -> exists, 434 line(s), 22614 bytes
  ```
- [2026-09-20T19:04:00Z] [CX9] Implemented the manager-roster guard in shared `retireRole`, using a conditional update that preserves the legacy tenant-wide route for non-managers. Added real-Postgres DB, Claude-lane, and Gemini-lane coverage. DB and worker TypeScript builds pass; isolated worker suite exercised both new lane tests successfully. The isolated DB recursive run had one pre-existing/concurrent migration-fixture deadlock in TASK-084's backfill guard; all 27 roles tests, including TASK-313's three tests, passed.
- [2026-09-20T19:06:00Z] [CX9] Verification complete: `pnpm --filter @oikonomos/db run build` and `pnpm --filter @oikonomos/worker run build` both exited 0; `git diff --check` exited 0. `scripts/test-isolated.ps1 -Init -Root . -Filter @oikonomos/worker` exited 0 (worker suite includes the new real Claude and Gemini lane cases). The required full `scripts/test-isolated.ps1 -Init -Root .` then exited 0 after waiting for the shared isolated-DB lock.
