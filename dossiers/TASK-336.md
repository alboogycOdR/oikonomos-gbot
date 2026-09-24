# TASK-336 dossier

**Brief:** Guard Claude-lane Steel navigation (the Gemini lane was TASK-325)

**Assigned:** S5. **Depends on:** nothing.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T00:20:00Z] [CX9] Resumed on `task/TASK-336-cx9` from `master` after the previous worktree branch/local PLAN snapshot proved stale. Live shared PLAN has no REWORK finding. Preflight verified all five owned files exist: `chatRunDriver.ts` (2240 lines), `chatRunDriver.test.ts` (2818), `brokerHttpRoute.test.ts` (155), `packages/broker/src/index.ts` (807), and `index.test.ts` (415). Verified the unchecked Claude extractor, existing shared `guardNavigationTarget`, and broker's current generic failure collapse. Next: apply a category-only `BrokerFailure` reason and test the real Fastify/broker/destination path.
- [2026-09-24T00:31:00Z] [CX9] Implemented the Claude extractor guard and typed `navigation.denied.<category>` broker failure. `scripts/test-isolated.ps1 -Filter @oikonomos/broker`: 189/189 pass. `scripts/test-isolated.ps1 -Filter @oikonomos/worker`: all eight new destination guard assertions pass; unrelated failures are `budget.platform_exceeded`, Gemini HTTP 402 credit depletion, and `email.send` enabled-state drift. `scripts/test-isolated.ps1 -Filter @oikonomos/control-api`: `brokerHttpRoute.test.ts` 14/14 pass; its sole remaining failure is pre-existing TASK-121 FreeLLMAPI 400 vs 201. A first Fastify attempt showed that package exports resolve the stale built worker artifact under Vitest; the test now imports the live worker source so it proves the actual change.
- [2026-09-24T00:24:00Z] [CX9] Full recursive `scripts/test-isolated.ps1` completed: 15 packages pass; failures are confined to four non-owned packages/classes. DB: pre-existing project-suite failures plus TASK-084 migration-backfill deadlock. Evals harness: TASK-141 `budget.platform_exceeded`. Worker: pre-existing budget ceiling, Gemini HTTP 402 credit depletion, `email.send` enabled-state drift, and pg-boss timeout/liveness failures; all TASK-336 destination assertions pass. Control API: only pre-existing TASK-121 FreeLLMAPI 400 vs 201; `brokerHttpRoute.test.ts` is 14/14 green. No full-suite failure is attributable to a TASK-336 file.
