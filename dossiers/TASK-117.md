# TASK-117 Dossier

## Work Log

- [2026-09-03T21:58:00Z] [CX] New dispatch verified against the authoritative main-checkout PLAN.md. Preflight output (run from the main checkout because this worktree has a stale PLAN.md):

  ```text
  [preflight] TASK-117 Owned_Paths inspected in E:/DELL-PROJECTS/GROKBOT-CLONE
  [preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/control-api/src/app.ts  -> exists, 683 line(s), 25708 bytes
    FILE   services/control-api/src/ports.ts  -> exists, 116 line(s), 5049 bytes
    GLOB   services/control-api/src/**/*.test.ts  -> 2 file(s):
             services/control-api/src/auth.test.ts
             services/control-api/src/chat.routes.test.ts
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-03T22:02:00Z] [CX] Blocked before implementation: TASK-117 AC #3 requires a real chat run to execute a T0 action such as `Read` without a pending approval. Live `services/worker/src/chatRunDriver.ts` mounts only `allowedTools: ["Bash(*)"]` and creates a policy for only `Bash`, so no chat run can execute `Read`, `Glob`, or `Grep`. Making this acceptance criterion executable requires changing that worker file and likely its test, both outside TASK-117 `Owned_Paths`. No production or test source was changed.

- [2026-09-04T06:24:00Z] [CX] Resumed after scope correction. Implemented data-driven `sdk:builtin` grants after role creation, preserving the existing response, and mounted `Read(*)` with matching policy registration. Route tests pass with real Postgres, including a temporary registered `fs.read` default-tier mutation that proves grants use the live tier rather than a constant; the fixture restores it. Added the real chat-run Read/T0/no-pending-approval test. It is currently blocked by the shared DB/runtime sync: both the pre-existing TASK-116 Bash liveness test and the new Read test start a run then fail at lifecycle completion with `RunNotFoundError`; an earlier worker-test run also exposed the shared schema's TASK-120 partial-index mismatch. No product failure has been observed in the new grant path.

- [2026-09-04T04:59:47Z] [CX] Rebasing onto current `master` and rebuilding `@oikonomos/harness-factory`, control-api, and worker resolved the stale-dist blocker. `chat.routes.test.ts` passes 9/9 against real Postgres; `chatRunDriver.test.ts` passes 5/5, including the real mounted Read/T0/grant/no-pending-approval run. Full required gates are green: `pnpm -r test`, `pnpm -r build`, and `pnpm lint` all exited 0. Ready for review.
