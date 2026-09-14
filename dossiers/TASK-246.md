# TASK-246 — Workspace-1 follow-on — durable run-execution queue so a worker restart re-drives an interrupted run (restart resilience)

**Unit:** TBD · **Priority:** medium · **Depends_On:** TASK-238, TASK-244

## Brief
Today `reconcileInterruptedRuns` (`runLifecycle.ts:224-250`) → `resumeInterruptedRun` (`:47-55`) → `resumeRun` is a status flip; pg-boss registers only heartbeat and routine-poll (`workerJobQueue.ts:6-7`); chat runs are in-process promises fired from control-api. A restart loses the in-flight turn. Design first: an ADR (protected path, different-model review) deciding queue-driven run execution — job per run, singleton per run id, the TASK-238 gate becomes the consumer's concurrency, reconciliation re-enqueues rather than re-labels, governed side effects stay exactly-once via the approval nonce, anything else re-executed must be idempotent or parked. Build after the ADR is accepted. Unblocks the full A15 case.

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §9.2; ADR-007 replay window; ADR-001

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
Today `reconcileInterruptedRuns` (`runLifecycle.ts:224-250`) → `resumeInterruptedRun` (`:47-55`) → `resumeRun` is a status flip; pg-boss registers only heartbeat and routine-poll (`workerJobQueue.ts:6-7`); chat runs are in-process promises fired from control-api. A restart loses the in-flight turn. Design first: an ADR (protected path, different-model review) deciding queue-driven run execution — job per run, singleton per run id, the TASK-238 gate becomes the consumer's concurrency, reconciliation re-enqueues rather than re-labels, governed side effects stay exactly-once via the approval nonce, anything else re-executed must be idempotent or parked. Build after the ADR is accepted. Unblocks the full A15 case.

## Owned_Paths
services/worker/src/jobs/**, services/worker/src/runLifecycle.ts, services/worker/src/runLifecycle.test.ts, services/worker/src/chatRunDriver.ts, services/worker/src/chatRunDriver.test.ts, services/control-api/src/ports.ts, services/control-api/src/index.ts, docs/decisions/ADR-016-run-execution-queue.md

## Work Log

- [2026-09-12T13:18:00Z] [CX9] Read TASK-246's binding §9.2, ADR-001, and ADR-007; preflight confirmed only the seven non-doc code territories are writable. Drafted ADR-016 below for ORCH to lift into `docs/decisions/`, obtain Anthropic review, and record as accepted. No queue implementation has started, as required by the task's design gate.
- [2026-09-12T12:57:16Z] [CX9] Resumed after ADR-016 acceptance and read its binding R1-R3 changes. Preflight output: `services/worker/src/jobs/**` has five existing files; `runLifecycle.ts`, `chatRunDriver.ts`, `chatRunDriver.test.ts`, `control-api/src/ports.ts`, and `control-api/src/index.ts` exist; `runLifecycle.test.ts` is new territory. Blocked before implementation: production worker composition is `services/worker/src/main.ts:50-74`, outside Owned_Paths, and is the only live caller that boots `WorkerJobQueue`/runs reconciliation. R1 additionally requires moving the current direct executor call at `services/control-api/src/ports.ts:522-548` into a queue consumer, but its implementation is `services/worker/src/groupFanout.ts:45-107`, also outside Owned_Paths. Editing only the allowed API files would retain an API-process executor or duplicate execution logic, both prohibited by ADR-016. Need ownership widened to those two files (and `services/worker/src/main.test.ts` for the required real boot/restart liveness proof), or an ORCH-owned composition change that supplies a worker-side executor port.
- [2026-09-12T14:10:00Z] [CX9] Resumed after the ownership widening. Implemented the first durable path: `worker.run-execution` uses pg-boss singleton keys and is registered/consumed only by `runWorker`; control-api now persists a run, records submission `run.queued`, and enqueues its ID without constructing a driver. The worker owns driver execution and applies the TASK-238 gate at the consumer, with a second `run.queued` (`consumer_gate`) on contention. Restart reconciliation excludes parked approvals, emits awaited `run.requeued`, resumes Claude runs with a session, and otherwise closes the old run `failed` (`worker_restart`) before enqueuing a replacement. `pnpm --filter @oikonomos/worker typecheck`, worker build, and control-api typecheck pass. Next: add focused real-pg-boss restart/duplicate/approval/audit tests and reconcile the group-fanout path with ADR-016 R1 before requesting review.
- [2026-09-12T14:30:00Z] [CX9] Stopped for ownership/spec resolution before committing the carried queue implementation. `services/control-api/src/ports.ts` imports `enqueueRunExecution` from `@oikonomos/worker`, requiring the modified `services/worker/src/index.ts` barrel export, but `index.ts` is absent from TASK-246's current Owned_Paths. More importantly, ADR-016 R1 requires group fan-out to be queued and executed by the worker, while the current `requestGroupFanout` still calls `deliverBotToBotMessage` in the API process; its recipient list/body are not represented in the reference-only run job or persisted run fields, so a worker cannot reconstruct that governed action without an explicit persisted-command design. No code was committed; typechecks previously recorded in this dossier pass, but the required real pg-boss restart/duplicate/approval/audit tests are not yet written or run.
- [2026-09-12T15:00:00Z] [CX9] Fresh PLAN/ADR review confirms TASK-246 remains in_progress with no REWORK verdict, but the binding Review_Findings require registering the new queue in `services/worker/src/jobs/pgBossTestCleanup.ts`, which is outside current Owned_Paths. The existing API enqueue import also requires `services/worker/src/index.ts`, likewise outside territory. Both files have carried uncommitted TASK-246 changes from the prior checkpoint; I will not modify, commit, or revert out-of-territory files. Required resolution: widen TASK-246 ownership to these exact two files (or have ORCH make/commit those narrow integration changes), then resume focused real-pg-boss tests and R1 fan-out design/implementation.
- [2026-09-12T15:20:00Z] [CX9] Resumed after the ownership widening and verified the carried queue implementation against accepted ADR-016 R1-R3. Corrected a consumer identity defect: new queued runs must call the driver with `{ resume: { runId } }`, otherwise the driver creates a second run rather than executing the persisted one. `pnpm --filter @oikonomos/worker typecheck` and `pnpm --filter @oikonomos/control-api typecheck` pass. Remaining work: durable real-pg-boss lifecycle tests and the worker-owned fan-out command/replay path; neither has been claimed complete.
- [2026-09-12T15:26:00Z] [CX9] STOPPING CHECKPOINT — staging is blocked by stale zero-byte `E:\\DELL-PROJECTS\\GROKBOT-CLONE\\.git\\worktrees\\wt-codex9-GROKBOT-CLONE\\index.lock` (last-write 2026-09-12T14:35:37Z); `git add` reports it cannot create the lock. No active `git` process was identified. The environment rejected removal of that exact stale lock, so no code can be committed. Carried code remains unstaged; next action after lock removal is stage/commit, then implement real pg-boss restart/duplicate/parked-approval/audit evidence plus the ADR-016 R1 worker-side fan-out command path.

## ADR-016 draft

# ADR-016 — Durable run-execution queue

**Status:** Proposed (draft supplied by CX9; ORCH must place it in `docs/decisions/`, obtain a different-model review, and commit it before implementation begins.)

**Date:** 2026-09-12

**Related:** Workspace Wave §9.2; ADR-001; ADR-007; TASK-238 run-concurrency gate; TASK-246.

### Context

Control API request handlers currently invoke `runChatTask` as an un-awaited in-process promise. `reconcileInterruptedRuns` subsequently scans `started`, `resumed`, and `waiting_approval` rows and changes them to `resumed`, but does not hand them to an executor. `WorkerJobQueue` has durable pg-boss queues only for heartbeat and routine polling. Therefore a worker or control-api restart can leave a run status that suggests recovery without ever reaching a real executor turn.

The queue must repair liveness without weakening the broker boundary. ADR-001 continues to require L1 `PreToolUse` enforcement and fail-closed behaviour. The one exactly-once boundary for a governed external side effect remains the approval nonce: a replayed executor must not gain a second consumption opportunity. ADR-007's replay rule applies to the L1/L3 decision pair within a turn; it is not a licence to replay a side effect outside its nonce-bound approval path.

### Decision

1. Introduce a durable pg-boss queue named `worker.run-execution`. Its payload is a versioned, validated reference, initially `{ version: 1, runId }`; it carries neither task instructions, credentials, approval decisions, nor mutable policy data. The consumer loads the current run/task/role state through typed ports at execution time.

2. A run has one logical pending execution job. Enqueue uses pg-boss singleton semantics keyed by `runId`, so repeated submissions and boot reconciliation coalesce instead of creating concurrent workers for the same run. The handler must also re-read run state before execution; queue uniqueness is a liveness aid, not an authorisation or correctness boundary.

3. The production `runChatTask` port becomes an enqueue port. New chat submissions create/persist their run and enqueue it; approval grant/hand-back follows the normal decide path and enqueues the continuation only after that decision commits. The worker, not the API request process, owns calling the real chat driver.

4. The worker consumer applies TASK-238's global-two/per-role gate immediately before it invokes the real executor. A queued run that cannot acquire the gate remains queued/retries through the durable queue; it is not dropped and no executor starts outside that gate.

5. Boot reconciliation changes from `resumeInterruptedRun` status flipping to re-enqueueing only executable interrupted runs (`started` or `resumed`). For each successful re-enqueue it records append-only audit event `run.requeued` with actor `system:run-lifecycle` and payload containing at least `{ reason: "worker_restart" }`. A run in `waiting_approval` is deliberately excluded: it stays parked until the existing normal decision path resumes it. Terminal runs are never enqueued.

6. Consumer retry/re-drive is at-least-once for the executor. Before any replayed turn reaches a governed side effect, ADR-001's broker remains in force and the approval nonce is atomically single-use. Thus duplicate job delivery may re-run only operations explicitly idempotent for the same run/action identity; any operation that cannot prove idempotence must park and request/retain approval rather than execute. A successful consumed nonce must not be recreated, reset, or consumed again by the queue implementation.

7. The handler treats a stale/terminal/parked run as a no-op completion after recording diagnostic logging as appropriate. It must not call `resumeRun` for `waiting_approval`, and it must not manufacture a session reference. Restart recovery is an executor re-drive, not a claim that every provider can resume an old in-memory session.

### Consequences and implementation obligations

- The worker composition owns the queue and real executor wiring. Control API composition receives only a typed enqueue dependency; it must not retain a parallel fire-and-forget driver path.
- `run.requeued` is a required liveness signal, not merely a log line. Its write must be awaited before reconciliation reports a successful requeue, and tests query the actual audit event.
- Tests must prove: a safe fake executor started through the durable queue survives simulated worker stop/start and produces one final result; a replay with a consumed governed approval cannot perform a second side effect; a `waiting_approval` run remains parked across boot and resumes only after the ordinary decision path; duplicate enqueue/reconciliation of one `runId` cannot execute concurrently; and the production composition contains TASK-238's gate at the consumer boundary.
- The acceptance test must use a safe fake executor and real pg-boss/database lifecycle, not a paid provider or a hand-waved status mutation. It records the run id and audit evidence.

### Alternatives rejected

- **Keep status-flip reconciliation.** Rejected because it reports `resumed` while no executor is scheduled.
- **Run the driver directly from the API and add a retry loop.** Rejected because API-process lifetime is not durable and creates a second ungoverned concurrency path.
- **Re-enqueue `waiting_approval` rows at boot.** Rejected because it bypasses the user decision and conflicts with the parked-run semantics and approval nonce boundary.
- **Claim exactly-once execution for whole turns.** Rejected: pg-boss delivery and process death produce at-least-once execution. The narrowly defensible exactly-once guarantee is atomic approval-nonce consumption for governed side effects.

### Non-goals

This ADR does not make arbitrary model turns exactly once, persist an SDK session for providers that have none, alter broker policy/replay-window semantics, or change the approval decision model. Those remain governed by ADR-001, ADR-007, and the existing approval implementation.
