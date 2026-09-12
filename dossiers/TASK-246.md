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
