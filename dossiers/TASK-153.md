# TASK-153 — Chat-run workspace and environment isolation

## Work Log

- [2026-09-05T09:20:00Z] [CX9] Preflight completed: `services/worker/src/executeRun.ts` (FILE, 350 lines), `services/worker/test/executeRun.test.ts` (FILE, 162 lines), `services/worker/src/chatRunDriver.ts` (FILE, 450 lines), `services/worker/src/chatRunDriver.test.ts` (FILE, 811 lines).
- [2026-09-05T09:28:00Z] [CX9] Traced the live composition path: `runChatTask` in `services/worker/src/chatRunDriver.ts` calls `executeTaskRun`; `executeTaskRun` in `services/worker/src/executeRun.ts` invokes `runtime.harness.query`. The Agent SDK `options` bag is then assembled by `createHarness` in `packages/harness-factory/src/index.ts` (caller options are spread before governed permission/hooks) and MCP decoration is applied by `attachMcpServersToQuery` through `composeHarness`. This task passes process settings at the owned `executeTaskRun` call boundary; no harness-factory change is needed.
- [2026-09-05T09:36:00Z] [CX9] Implemented a fresh `mkdtemp` workspace per persisted run ID and explicit `env: {}` for every chat-run SDK query. Workspace cleanup is in the execution `finally`, so it runs on both success and query failure, after connector handles are released.
- [2026-09-05T09:42:00Z] [CX9] Added mutation-sensitive coverage. The real PostgreSQL chat-driver run enters the normal `createChatRunDriver → runChatTask → executeTaskRun → composed harness` path. Its SDK seam receives the actual options bag, launches Bash using that exact `cwd`/`env`, verifies `pwd` is the fresh workspace and a test-process-injected secret is absent, then verifies the directory no longer exists after completion. Removing the explicit options causes the test's empty-env/cwd assertions to fail.

## Security boundary and scope

`env: {}` was validated against the existing real Agent SDK governed-run liveness test, which still completes successfully; no inherited worker secret is needed for Bash or Read tool operation in this path. This is a narrow host-process mitigation, not a sandbox: a bot can still reach host paths outside its cwd or the network when policy permits. The next real step is the separately-scoped container-based isolation work that wires TASK-142's OpenSandbox client into chat execution.

## Test Evidence

- `pnpm --filter @oikonomos/worker typecheck` — exit 0.
- `pnpm --filter @oikonomos/worker test` — exit 0; 13 files passed, 66 tests passed, 1 skipped. Includes TASK-153 Bash/cwd/env/cleanup test and existing real TASK-116/117/128/139/146 coverage.
