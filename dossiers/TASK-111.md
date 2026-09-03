# TASK-111 — chat task→run execution driver

## Work Log

- [2026-09-03T07:40:41Z] [CX] Pre-flight completed before implementation. Verbatim output:
  ```text
  [preflight] TASK-111 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    services/worker/src/chatRunDriver.ts  -> does not exist; parent services/worker/src/ exists
    NEW    services/worker/src/chatRunDriver.test.ts  -> does not exist; parent services/worker/src/ exists
    FILE   services/control-api/src/app.ts  -> exists, 680 line(s), 25322 bytes
    FILE   services/control-api/src/ports.ts  -> exists, 112 line(s), 4738 bytes
    GLOB   services/control-api/src/**/*.test.ts  -> 2 file(s):
             services/control-api/src/auth.test.ts
             services/control-api/src/chat.routes.test.ts
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-03T07:40:41Z] [CX] Blocked before code changes. The sole real control-api process entrypoint, `services/control-api/src/index.ts#start`, constructs `createDatabaseBackedDeps({ connectionString })` then calls `buildApp(deps)`; it is outside TASK-111 Owned_Paths. `app.ts` can only call a driver supplied through `ControlApiDeps`, but `ports.ts#createDatabaseBackedDeps` cannot construct one without importing the worker. `services/control-api/package.json` has no `@oikonomos/worker` dependency and is outside territory. Conversely, `services/worker/package.json` declares only agent-providers/broker/db/harness-factory; the required production `BrokerDependencies` adapter needs direct `@oikonomos/audit`, `@oikonomos/approvals`, and policy/database capability/grant access, whose manifest additions are also out of territory. A driver added only to the owned worker files would have no production caller; adding an optional fake seam would satisfy neither the real execution nor the fire-and-forget requirement. No code was changed and no inference spend occurred.

## Required unblock

Please expand TASK-111 territory to include the integration composition root(s) and required workspace manifests, or provide an existing production composition factory and a worker-dispatch attachment point. The smallest apparent set is `services/control-api/src/index.ts`, `services/control-api/package.json`, and `services/worker/package.json`; a task-owned composition root may be preferable if ORCH assigns one explicitly.

## Work Log (continued)

- [2026-09-03T10:57:14Z] [CX] Resumed after ORCH expanded the current shared territory to include `services/control-api/src/index.ts`, both service manifests, and the original driver/API files. Re-ran preflight against the updated task block: all 8 owned entries are present/new as expected. The original composition-root blocker is resolved, but implementation remains blocked by two precise, independently verified ownership/API gaps: (1) `services/worker/src/executeRun.ts` always drives `runtime.harness.query()` (the Claude Agent SDK path); its Codex/Grok provider instances are constructed but never invoked. A production Codex/Grok run therefore needs an owned change to that file (or an existing exported execution seam), whereas `chatRunDriver.ts` cannot pass a `CodexProvider`/`GrokProvider` as `AgentSdkQueryFn`. (2) `services/worker/src/runLifecycle.ts` and `@oikonomos/db` expose only start/resume/fail/cancel; there is no `completeRun`/`completeTaskRun`. Calling `cancelTaskRun` after a successful bot reply would persist the wrong lifecycle result and violate the task's completion requirement. `runLifecycle.ts` is outside TASK-111 territory; adding the missing DB completion transition would also require a protected `packages/db` change. No application code, inference call, or test fixture was added under this resumed dispatch.

## Required unblock (continued)

Please either (a) expand TASK-111 territory to `services/worker/src/executeRun.ts` and `services/worker/src/runLifecycle.ts`, and create/assign the required `@oikonomos/db` completion-transition work, or (b) provide existing exported seams for selecting a real Codex/Grok provider and completing a successful run. The present APIs cannot meet the real-provider and successful-terminal-lifecycle acceptance criteria without one of those changes.
