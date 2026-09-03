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
