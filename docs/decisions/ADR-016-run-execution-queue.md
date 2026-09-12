# ADR-016 — Durable run-execution queue

**Status:** Accepted-with-changes (2026-09-12). Drafted by CX9 / Codex GPT (TASK-246, delivered via its dossier because `docs/decisions/**` is outside builder territory); adversarially reviewed by ORCH on Claude Fable 5.1 (a different model from the author, satisfying CLAUDE.md's protected-path rule); the three required changes are applied in §Resolution and bind the implementation.

**Date:** 2026-09-12

**Related:** `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §9.2; ADR-001 (broker enforcement point); ADR-007 (replay window); TASK-238 (run-concurrency gate, `run.queued` evidence at admission); TASK-246 (implementing task); TASK-251 (test races that a queue-driven consumer must not reintroduce).

## Context

Control API request handlers currently invoke `runChatTask` as an un-awaited in-process promise (`services/control-api/src/app.ts:1738,1756,2131` at `ae122be`, now wrapped by TASK-238's gate in `ports.ts`). `reconcileInterruptedRuns` (`services/worker/src/runLifecycle.ts:224-250`) subsequently scans `started`, `resumed`, and `waiting_approval` rows and changes them to `resumed`, but does not hand them to an executor. `WorkerJobQueue` has durable pg-boss queues only for heartbeat and routine polling. Therefore a worker or control-api restart can leave a run status that suggests recovery without ever reaching a real executor turn.

The queue must repair liveness without weakening the broker boundary. ADR-001 continues to require L1 `PreToolUse` enforcement and fail-closed behaviour. The one exactly-once boundary for a governed external side effect remains the approval nonce: a replayed executor must not gain a second consumption opportunity. ADR-007's replay rule applies to the L1/L3 decision pair within a turn; it is not a licence to replay a side effect outside its nonce-bound approval path.

## Decision

1. Introduce a durable pg-boss queue named `worker.run-execution`. Its payload is a versioned, validated reference, initially `{ version: 1, runId }`; it carries neither task instructions, credentials, approval decisions, nor mutable policy data. The consumer loads the current run/task/role state through typed ports at execution time.

2. A run has one logical pending execution job. Enqueue uses pg-boss singleton semantics keyed by `runId`, so repeated submissions and boot reconciliation coalesce instead of creating concurrent workers for the same run. The handler must also re-read run state before execution; queue uniqueness is a liveness aid, not an authorisation or correctness boundary.

3. The production `runChatTask` port becomes an enqueue port. New chat submissions create/persist their run and enqueue it; approval grant/hand-back follows the normal decide path and enqueues the continuation only after that decision commits. The worker, not the API request process, owns calling the real chat driver. **(Amended by change R1)** The group fan-out path (`deliverBotToBotMessage`, today invoked from `ports.ts` behind the same gate) enqueues through the identical port; no run of any kind starts from the API process.

4. The worker consumer applies TASK-238's global-two/per-role gate immediately before it invokes the real executor. A queued run that cannot acquire the gate remains queued/retries through the durable queue; it is not dropped and no executor starts outside that gate. **(Amended by change R3)** The enqueue port still emits TASK-238's enqueue-time `run.queued {taskId, roleId, position, reason}` audit event at submission (evidence written before the job exists, as TASK-238 established); if the consumer's gate then makes the run wait again, it emits a second `run.queued` with `reason: "consumer_gate"` so a waiting run is always visible to the workspace summary.

5. Boot reconciliation changes from `resumeInterruptedRun` status flipping to re-enqueueing only executable interrupted runs (`started` or `resumed`). For each successful re-enqueue it records append-only audit event `run.requeued` with actor `system:run-lifecycle` and payload containing at least `{ reason: "worker_restart" }`. A run in `waiting_approval` is deliberately excluded: it stays parked until the existing normal decision path resumes it. Terminal runs are never enqueued.

6. Consumer retry/re-drive is at-least-once for the executor. Before any replayed turn reaches a governed side effect, ADR-001's broker remains in force and the approval nonce is atomically single-use. Thus duplicate job delivery may re-run only operations explicitly idempotent for the same run/action identity; any operation that cannot prove idempotence must park and request/retain approval rather than execute. A successful consumed nonce must not be recreated, reset, or consumed again by the queue implementation.

7. The handler treats a stale/terminal/parked run as a no-op completion after recording diagnostic logging as appropriate. It must not call `resumeRun` for `waiting_approval`, and it must not manufacture a session reference. **(Amended by change R2)** Re-drive semantics are explicit: if the run's provider supports session resume and the run has a persisted `session_ref`, the consumer resumes **that run** through the existing `resume` path; otherwise the interrupted run is closed `failed` with `failure_note = "worker_restart"` and the consumer starts a **new run on the same task**, whose prompt is assembled from the persisted thread state (so tool side effects that already landed are visible to the model as history, not replayed). Both branches record `run.requeued` with `{ reason, mode: "resume" | "new_run", previous_run_id }`, so spend, audit and the workspace summary attribute correctly and no run is reported `resumed` without an executor.

## Consequences and implementation obligations

- The worker composition owns the queue and real executor wiring. Control API composition receives only a typed enqueue dependency; it must not retain a parallel fire-and-forget driver path — for chat runs or for group fan-out.
- `run.requeued` is a required liveness signal, not merely a log line. Its write must be awaited before reconciliation reports a successful requeue, and tests query the actual audit event.
- Tests must prove: a safe fake executor started through the durable queue survives simulated worker stop/start and produces one final result; a replay with a consumed governed approval cannot perform a second side effect; a `waiting_approval` run remains parked across boot and resumes only after the ordinary decision path; duplicate enqueue/reconciliation of one `runId` cannot execute concurrently; the production composition contains TASK-238's gate at the consumer boundary; a fan-out delivery goes through the queue; the `new_run` re-drive branch closes the old run `failed` and starts exactly one new run; enqueue-time `run.queued` is still emitted at submission.
- The acceptance test must use a safe fake executor and real pg-boss/database lifecycle, not a paid provider or a hand-waved status mutation. It records the run id and audit evidence. Given TASK-251, the consumer tests must use an injected clock or boundary-safe scheduling and must not share pg-boss queue names with the routine-poll tests' cleanup helper without registering the new queue there.
- Admission latency: a submitted run now starts after pg-boss's poll interval rather than synchronously; the dashboard's pending state (TASK-236) and summary poll (TASK-239) already tolerate this, and the enqueue-time `run.queued` event makes the wait visible rather than silent.

## Alternatives rejected

- **Keep status-flip reconciliation.** Rejected because it reports `resumed` while no executor is scheduled.
- **Run the driver directly from the API and add a retry loop.** Rejected because API-process lifetime is not durable and creates a second ungoverned concurrency path.
- **Re-enqueue `waiting_approval` rows at boot.** Rejected because it bypasses the user decision and conflicts with the parked-run semantics and approval nonce boundary.
- **Claim exactly-once execution for whole turns.** Rejected: pg-boss delivery and process death produce at-least-once execution. The narrowly defensible exactly-once guarantee is atomic approval-nonce consumption for governed side effects.

## Non-goals

This ADR does not make arbitrary model turns exactly once, persist an SDK session for providers that have none, alter broker policy/replay-window semantics, or change the approval decision model. Those remain governed by ADR-001, ADR-007, and the existing approval implementation.

## Adversarial review — 2026-09-12, ORCH on Claude Fable 5.1 (different model from the CX9/GPT author)

Verified against the code, not the draft's description of it: `runChatTask` is fired from three call sites in `app.ts` and composed in `ports.ts:393` (now gated, TASK-238); `groupFanout.ts` delivers through the same port; `reconcileInterruptedRuns` flips status only; pg-boss registers heartbeat and routine-poll only (`jobs/workerJobQueue.ts:6-7`); `runs.session_ref` exists and the Claude lane already has a `resume` path used after approval (TASK-155).

Sound as drafted: reference-only payload; per-`runId` singleton with re-read before execution; `waiting_approval` excluded from boot re-enqueue; honest at-least-once with the nonce as the sole exactly-once boundary; consumer-side gate.

Required changes (all applied above):

- **R1 — fan-out is a second entry point.** The draft's "must not retain a parallel fire-and-forget path" did not name `deliverBotToBotMessage`, which starts a run from the API process today. Decision 3 now makes it explicit.
- **R2 — "executor re-drive" was underspecified.** Two providers behave differently: the Claude lane can resume a persisted session; the Gemini lane cannot. Without a rule, an implementer would either resume a run that has no session (manufacturing state, which decision 7 forbids) or leave the interrupted run in a non-terminal status forever. Decision 7 now fixes: resume when `session_ref` exists and the provider supports it, else close `failed` + new run on the same task from persisted thread state, both audited with `mode` and `previous_run_id`.
- **R3 — TASK-238's evidence must not regress.** Moving the gate to the consumer would have moved the only `run.queued` emission to a point after the job exists, undoing the enqueue-time evidence that TASK-238's rework established as spec §5.3's requirement. Decision 4 now keeps the submission-time event and adds a consumer-side one.

Non-gating notes: pg-boss `singletonKey` only dedupes jobs in created/active state, which is what decision 2 needs; the routine-poll cleanup helper (`jobs/pgBossTestCleanup.ts`) must learn the new queue name or the isolated suite will leak jobs between files (TASK-251's family).

## Resolution

R1, R2 and R3 applied 2026-09-12 in decisions 3, 7 and 4 and in the test obligations. ADR is Accepted; TASK-246 implements against this text.
