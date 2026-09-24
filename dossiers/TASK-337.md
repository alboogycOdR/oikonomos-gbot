# TASK-337 dossier

**Brief:** Sandbox reaper re-checks idleness before reaping and logs give-ups

**Assigned:** CX9. **Depends on:** TASK-330.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T17:39:26Z] [CX9] Resumed the pre-dispatched branch and verified the reported selection-to-reap race against the implementation. Preflight evidence (c8b9872):
  ```text
  [preflight] TASK-337 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/worker/src/sandboxReaper.ts  -> exists, 372 line(s), 17051 bytes
    FILE   services/worker/src/sandboxReaper.test.ts  -> exists, 493 line(s), 24616 bytes
    FILE   packages/db/src/roleSandboxes.ts  -> exists, 161 line(s), 6771 bytes
    FILE   packages/db/src/roleSandboxes.test.ts  -> exists, 84 line(s), 3973 bytes
    FILE   packages/db/src/index.ts  -> exists, 361 line(s), 8354 bytes
  ```
  Added the atomic `claimRoleSandboxForReap` conditional update, real-Postgres race coverage, and bounded categorized give-up logging. Marked failed first-pass releases as handled before provider destruction so reconciliation cannot make a second release/log attempt in the same sweep; the give-up test now supplies the same provider-listed sandbox to prove exactly three attempts and one give-up log. `pnpm --filter @oikonomos/db typecheck`, `pnpm --filter @oikonomos/worker typecheck`, and `git diff --check` pass. `scripts/test-isolated.ps1 -Init` completed database setup; its required full recursive run passed 18 packages and failed only master-baseline TASK-121 (`services/control-api/src/chat.routes.test.ts:1459` expects the scrubbed fixture to produce Gemini, while unmerged TASK-344 commit `f581bed` correctly expects Claude). Isolated worker rerun passed 39 files, 373 tests, 1 skipped.
