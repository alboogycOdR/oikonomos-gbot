# TASK-071 — Work Log

- [2026-09-01T16:10:00Z] [CX] Fresh claim on `task/TASK-071-cx`. Preflight output: `packages/harness-factory/src/decorators/**` is new territory and `packages/harness-factory/test/decorators.test.ts` is new territory. Blocked before code: the acceptance criterion requiring `composeHarness` to apply the decorator chain to every mounted tool (and its mutation proof) requires changes to `packages/harness-factory/src/compose.ts`, which is not in this task's `Owned_Paths`. The live composition root currently calls `createHarness()` directly and has no decorator integration. Please add `packages/harness-factory/src/compose.ts` to TASK-071's Owned_Paths (and, if public exports are required, `packages/harness-factory/src/index.ts`); then resume on this branch.

Layering noted per the task: decorator scope retirement is client-side hygiene only; the atomic SQL approval consume in `packages/approvals` remains the N8 enforcement point.
