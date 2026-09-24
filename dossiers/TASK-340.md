# TASK-340 dossier

**Brief:** Gemini Steel lane: actionable element refs from snapshots

**Assigned:** S5. **Depends on:** nothing.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log
- [2026-09-24T01:20:00Z] [S5] Implemented buildActionableElements (16-role allow-list, e1.., cap 200, state props), per-session ref map, navigate/release invalidation, steel_act `ref` via DOM.resolveNode + Runtime.callFunctionOn (runner gained `objectIdFromStep`). Stale/unknown refs refused with readable sentences. Nav guard untouched. geminiToolExecutors.test.ts 30/30. Full isolated suite: failures only in db(1), evals-harness(1), control-api chat.routes(1), worker chatRunDriver/main/workerJobQueue/roleMessageDelivery (sandbox/env; matching runMaster-worker-baseline.log worker failures: chatRunDriver, main, workerJobQueue). None touch geminiToolExecutors.
