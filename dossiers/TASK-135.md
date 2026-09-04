# TASK-135 — OIK-107: prove durable resume never re-executes a pending-approval tool call

Unit: S5. Branch: `task/TASK-135-s5` (created off `mainco/master` tip
`d791848`, post TASK-131/133/134 claims — TASK-133 was already merged to
`mainco/master` by the time this session started, per PLAN.md's
`Status: done` on that block).

## Work Log

- [2026-09-04T17:15:00Z] [S5] Session start note: the SessionStart hook's
  checkpoint (`.devteam/CHECKPOINT.md`) named TASK-133 as the active task,
  but PLAN.md on `mainco/master` shows TASK-133 already `done` (merged,
  reviewed, approved-first-pass by ORCH) and my actual dispatch prompt
  names TASK-135, freshly `claimed`. Resolved by trusting PLAN.md (the
  blackboard, per AGENTS.md commandment 1) over the stale checkpoint —
  the checkpoint predates ORCH's TASK-133 merge. Deleted
  `.devteam/CHECKPOINT.md` is out of scope for me to touch (not in
  Owned_Paths, and it isn't listed as something builders may edit); left
  it in place since PLAN.md itself is the authoritative resolution and a
  future session will get a fresh, correct hook message once ORCH's own
  tooling regenerates or clears it.

  **Investigation** (per the task's own instruction to investigate before
  writing new production code): traced the full path from a T2/T3 tool
  call to a pending approval to see whether resuming a run can possibly
  re-invoke the underlying tool.

  - `services/worker/src/runLifecycle.ts`'s `resumeInterruptedRun` /
    `reconcileInterruptedRuns` (TASK-133) import only from `@oikonomos/db`
    — no harness, no broker, no tool adapter, nothing that could invoke a
    tool. Reconciliation is a pure DB status transition
    (`started`/`waiting_approval`/`resumed` → `resumed`, via `resumeRun`'s
    `UPDATE ... WHERE status IN (...)`). It never touches the Agent SDK
    session, never re-issues a prompt, never calls a tool. The safety
    property OIK-107 cares about therefore **holds by construction** —
    exactly the alternative the task description names as possible.

  - **Real gap found, not fixed (ownership boundary), documented
    honestly**: `packages/harness-factory/src/compose.ts`'s `withPark`
    already treats `"approval_pending"` as a park reason
    (`PARK_REASONS = new Set([...FAIL_CLOSED_REASONS, "approval_pending"])`,
    line 246) — i.e. the harness *is* built to notify a `RunParkPort` when
    a tool call is denied because an approval is pending. But
    `services/worker/src/chatRunDriver.ts`'s `runChatTask` never passes a
    `park` option into `executeTaskRun` (`services/worker/src/executeRun.ts`
    accepts `park?: RunParkPort` and forwards it, but the only production
    caller, `chatRunDriver.ts`, never supplies one). Confirmed via
    `grep -rn "park:"` across `services/worker/src` and
    `packages/harness-factory/src`: the only non-test assignment of `park`
    is the pass-through in `executeRun.ts` itself; nothing constructs a
    `RunParkPort`. Net effect: **no real chat run today is ever
    transitioned to `waiting_approval` in the database** — a run that hits
    a pending approval currently keeps running to whatever its Agent SDK
    turn naturally concludes at (and would exit `runChatTask`'s try block
    normally, calling `completeTaskRun`), leaving the pending approval row
    orphaned from the run's now-`completed` status.

    Fixing this for real needs a new `packages/db/src/runs.ts` transition
    (`started`/`resumed` → `waiting_approval`; today's exports are
    `startRun`/`getRun`/`resumeRun`/`failRun`/`completeRun`/`cancelRun`/
    `listRuns`/`listOpenRuns` — none targets `waiting_approval` as a
    destination status). `packages/db/src/runs.ts` is **not** in this
    task's `Owned_Paths` (only `services/worker/src/runLifecycle.ts`,
    `services/worker/test/runLifecycle.test.ts`,
    `services/worker/src/chatRunDriver.ts`,
    `services/worker/src/chatRunDriver.test.ts`). Per commandment 4, not
    touching it — flagging as a real, separate follow-up ticket
    (production `park` wiring + a `waiting_approval` DB transition) for
    whoever owns `packages/db`, same honesty pattern TASK-133's own
    dossier used for the barrel-export gap.

  Given the property already holds by construction, and the only path to
  a genuine production fix crosses an ownership boundary, this task is —
  per its own stated alternative branch — "primarily about writing the
  real end-to-end proof, not new production code." No `chatRunDriver.ts`
  changes were made (it was read in full during investigation but needed
  no code change for this task's actual ACs).

  **Test built** (`services/worker/test/runLifecycle.test.ts`, appended
  after the existing TASK-133 `reconcileInterruptedRuns` suite): two new
  `it`s under a new `describe` block, using real Postgres, real
  `@oikonomos/approvals` (`issueApproval`, `grantApproval`,
  `verifyAndConsume` — the same functions `chatRunDriver.ts` already wires
  into its `brokerDependencies`), and real `@oikonomos/db`
  (`Database.upsertCapability`, matching the exact FK-satisfying pattern
  `chatRunDriver.ts`'s `deliverBotToBotMessage` already uses for
  `chat.bot_fanout`, a capability with no connector manifest).

  1. **"resuming a run parked mid-approval-wait never re-invokes the
     governed tool, and the original nonce still completes the run"**
     (AC1 + AC2, the primary proof):
     - A real run (`startTaskRun`) reaches a real pending approval
       (`issueApproval`) for a fixture T2 capability. A local call counter
       (`sideEffectInvocations`) stands in for the tool adapter's actual
       side effect (e.g. "send the email") — the real production
       invariant is that this side effect only ever runs on a granted
       `verifyAndConsume`, never on issuance.
     - The run is parked at `waiting_approval` via a direct
       `UPDATE runs SET status = 'waiting_approval'` — the same
       construct-the-state-directly convention `runs.test.ts`'s own
       `listOpenRuns` fixture and TASK-133's `runLifecycle.test.ts` suite
       already use to simulate a killed process, and the only route
       available given the production wiring gap documented above.
     - `reconcileInterruptedRuns({taskId})` finds and resumes it
       (`outcome: "resumed"`, status flips to `resumed`). **Assertion**:
       `sideEffectInvocations` is still `0` — not "no error was thrown",
       a real counter proving the governed tool was not invoked during
       resume.
     - The pending approval row is asserted unchanged (`status: "pending"`,
       same `nonce`) — reconciliation never touches the `approvals` table
       at all.
     - AC2: the *original* nonce (issued before the simulated worker
       death, unchanged by resume) is granted (`grantApproval`) and
       consumed (`verifyAndConsume`, `consumed: true`, `approval.runId`
       matches). Only now does `invokeGovernedTool()` run — the counter
       goes from `0` to `1`, proving the effect fires exactly once, at the
       correct point, using the pre-resume nonce. `completeTaskRun`
       succeeds.
     - Single-use replay proof (the exact double-execution risk OIK-107
       names): consuming the same nonce a second time after completion
       returns `consumed: false`, and the counter stays at `1` — the tool
       is never invoked twice even if something tried to replay the
       nonce post-resume.

  2. **"a completed run's already-consumed approval is never re-fetched
     by reconciliation"** (mutation-proof companion to TASK-133's own
     terminal-run test, scoped to the approval case specifically):
     issues, grants, consumes, and completes a run exactly as above, then
     calls `reconcileInterruptedRuns` and asserts the now-terminal run's
     id is absent from the outcomes (its status is `completed`, outside
     `OPEN_RUN_STATUSES`) and that a nonce replay still fails — closing
     the loop that a completed run's approval can't somehow be
     resurrected by a later reconciliation pass.

  **Environment note, not a code issue**: `services/worker/node_modules/
  @oikonomos/workspace` was initially unlinked (pre-existing, same class
  of gap TASK-133's dossier documented for `pg-boss`) — `pnpm build`
  failed on `workspaceMcpServer.ts`'s import until `pnpm install
  --no-frozen-lockfile` (lockfile unchanged) relinked it. Unrelated to
  this diff; fixed the same way TASK-133 fixed its own `pg-boss` gap.

## Test Evidence

- `services/worker`: `pnpm --filter @oikonomos/worker exec vitest run
  test/runLifecycle.test.ts` → **8/8 passed** (the 6 pre-existing TASK-034/
  TASK-133 tests plus the 2 new TASK-135 tests), real Postgres.
- `services/worker` full package: `pnpm --filter @oikonomos/worker exec
  vitest run` → **57 passed, 1 skipped** across 11/12 files;
  `src/registerCapabilities.test.ts`'s "leaves the complete declaration
  inventory byte-identical on a second registration" failed in this run
  but passed clean in isolation
  (`pnpm --filter @oikonomos/worker exec vitest run
  src/registerCapabilities.test.ts` → 3/3 green) — a full-suite
  contention/stale-snapshot flake (manifest description text vs. a
  previously-registered DB row from shared-Postgres state), not touched
  by this diff, not in this task's `Owned_Paths`, and confirmed identical
  in `pnpm -r test` below.
- `pnpm exec tsc --noEmit -p services/worker`: clean.
- `pnpm -r build` (whole repo, 17 buildable projects): clean, exit 0.
- `pnpm lint` (whole repo root `eslint .`): clean, exit 0.
- `pnpm -r --no-bail test` (whole repo, per the CLAUDE.md amendment
  requiring the full recursive suite): **16 of 17 workspace projects
  passed clean** — `packages/approvals` 119/119,
  `packages/harness-factory` 102/102, `packages/broker` 120/120,
  `evals/harness` 18/18, `evals/golden` 6/6, `services/gateway-telegram`
  68/68, `services/control-api` 130/130, and every other workspace not
  listed passed with 0 failures. `services/worker` was the sole failing
  project, and its only failure was the same
  `registerCapabilities.test.ts` flake documented above (57 passed / 1
  failed / 1 skipped), reconfirmed clean in isolation. Every test this
  task's diff touches (`services/worker/test/runLifecycle.test.ts`, all 8
  tests, both suites) passed in both the full-suite run and isolation.

## Status

Handing to `needs_review`. Artifacts:
`services/worker/test/runLifecycle.test.ts`, `dossiers/TASK-135.md`.

No `chatRunDriver.ts` production changes — the OIK-107 safety property
holds by construction (reconciliation is DB-only, imports nothing that
could invoke a tool). A real, separate production gap was found and
documented rather than crossed: `chatRunDriver.ts` never wires a
`RunParkPort`, so no real run reaches `waiting_approval` in production
today; closing that needs a new `packages/db/src/runs.ts` transition
export, outside this task's `Owned_Paths`.
