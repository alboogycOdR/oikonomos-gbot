# TASK-150 Dossier

## Work Log

- [2026-09-04T22:12:00Z] [CX9] Stopped before implementation. Dispatcher specified resuming `task/TASK-150-cx9`, but `git branch -a --list "*TASK-150*"` returned no branch and the worktree remains on unrelated `task/TASK-146-cx9`. `node_modules/@anthropic-ai/claude-agent-sdk` is also absent in this worktree. Blocked as SYNC_MISMATCH; supervisor must provide/create the assigned branch (and expected dependency installation state) before work can safely resume.

- [2026-09-04T22:22:00Z] [CX9] Resumed on the dispatcher-provisioned `task/TASK-150-cx9`. Preflight evidence before writes:

  ```text
  [preflight] TASK-150 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    packages/harness-factory/src/budgetTap.ts  -> does not exist; parent packages/harness-factory/src/ exists
    NEW    packages/harness-factory/src/budgetTap.test.ts  -> does not exist; parent packages/harness-factory/src/ exists
    FILE   packages/harness-factory/src/index.ts  -> exists, 378 line(s), 10987 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-04T22:22:00Z] [CX9] Inspected the installed `@anthropic-ai/claude-agent-sdk` v0.3.233 declarations directly. A terminal `SDKResultMessage` has `type: "result"` (success or error), numeric `total_cost_usd`, `usage`, and `modelUsage: Record<string, ModelUsage>`. `ModelUsage` carries `inputTokens`, `outputTokens`, `cacheReadInputTokens`, and `cacheCreationInputTokens`; the SDK documents `modelUsage` as the complete query-pipeline total, including subagents and internal calls, while `usage` is main-agent-only. Recommended future composition point: wrap the final `harness.query` returned by `composeHarness()` (after `attachMcpServersToQuery` when mounted), so the tap observes the primary SDK path without changing this prototype's deliberately limited scope.

- [2026-09-04T22:25:00Z] [CX9] Implemented `withBudgetTap(queryFn, sink)` in `packages/harness-factory/src/budgetTap.ts` and exported it from the package barrel. It forwards every original event unchanged, reports a validated SDK result's `total_cost_usd` plus a complete `modelUsage` token aggregate before yielding that result, and throws `BudgetTapError` without yielding it if the sink fails. Cost-less/malformed-cost streams intentionally leave the sink uncalled. No production composition or call site was changed.

- [2026-09-04T22:27:00Z] [CX9] Test evidence: `pnpm --filter @oikonomos/harness-factory test` PASS — 15 files, 105 tests; includes all 3 new tap tests. `pnpm -r test` PASS (exit 0). `pnpm lint` PASS (exit 0). `pnpm -r build` FAIL (exit 2) outside TASK-150 territory: `services/control-api/src/app.ts(5,38): TS2307 Cannot find module 'cron-parser' or its corresponding type declarations.` `services/control-api/package.json` declares `cron-parser@^5.10.0`, and its package exists in the pnpm store (`node_modules/.pnpm/cron-parser@5.10.0`), but it is not resolvable by the workspace build — a dependency-link/install-state mismatch. No authorised path can repair this from TASK-150.

## Stopping point

Implementation, focused tests, repository tests, and lint are complete. The task cannot meet its required recursive-build acceptance criterion until the shared workspace dependency link for `cron-parser` is repaired. Supervisor action required: restore the control-api package's install/link state, then re-run `pnpm -r build`; no TASK-150 code change is indicated.
