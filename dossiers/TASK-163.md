# TASK-163 Dossier

## Work Log

- [2026-09-07T03:30:00Z] [GB] Session start. `control.mode=strict`: PLAN.md not
  touched. Review_Findings empty (first pass, not rework). No prior dossier.
  Created `task/TASK-163-gb` from detached HEAD (`git checkout -b`). Preflight:

  ```text
  [preflight] TASK-163 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/harness-factory/src/compose.ts  -> exists, 424 line(s), 14140 bytes
    NEW    packages/harness-factory/src/compose.test.ts  -> does not exist; parent packages/harness-factory/src/ exists
    FILE   packages/db/src/spend.ts  -> exists, 241 line(s), 8543 bytes
    FILE   services/worker/src/chatRunDriver.ts  -> exists, 581 line(s), 30768 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

  Grounding (read live, not ATLAS): TASK-150 already shipped `withBudgetTap`
  against `@anthropic-ai/claude-agent-sdk` v0.3.233 — terminal
  `{type:"result"}` carries numeric `total_cost_usd` and `modelUsage`
  (complete pipeline, including subagents). TASK-143 shipped `recordSpend` /
  `resolveBudgetGate` / `wrapGateWithBudget` for Codex/Grok only.
  `executeTaskRun` is the sole `composeHarness` caller and is **outside**
  Owned_Paths, so production wiring cannot add a new executeRun option.
  Approach: composeHarness grows optional `budgetTap`/`budgetCheck` plus
  `runWithChatBudget` ALS so the chat driver can bind the sink/check around
  `executeTaskRun` without that file changing. Sandbox CLI path records from
  a JSON result of the same SDK shape. Reuse TASK-143's spend schema
  (provider=`claude`), not a second table.

- [2026-09-07T03:45:00Z] [GB] Re-verified SDK types live in
  `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk*/.../sdk.d.ts`:
  `SDKResultSuccess` / `SDKResultError` both carry `total_cost_usd: number`
  and `modelUsage: Record<string, ModelUsage>` (`inputTokens`,
  `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`).
  SDK docs: `total_cost_usd` is cumulative — read the latest result, do not
  sum. `usage` is main-agent-only; `modelUsage` is the accounting field.
  Matches TASK-150's `withBudgetTap` parser exactly.

- [2026-09-07T04:10:00Z] [GB] Implementation:

  1. `composeHarness` wraps the final `harness.query` (after MCP attach)
     with `withBudgetTap` when a sink is bound, and wraps L1 with a live
     budget check that denies `budget.routine_exceeded` /
     `budget.platform_exceeded` / `budget.check_failed` *before* the
     broker. Budget denies are not PARK_REASONS. Explicit
     `ComposeOptions.budgetTap`/`budgetCheck` plus `runWithChatBudget` ALS
     for the worker (executeRun.ts is out of territory).
  2. `spend.ts` now documents both inference paths writing the same table;
     `CLAUDE_SDK_SPEND_PROVIDER = "claude"`. No schema change.
  3. `chatRunDriver` pre-flight `resolveBudgetGate` (reused, not
     duplicated), records via `recordSpend` from the SDK result (local
     queryFn / default SDK path through ALS) and from sandbox CLI JSON
     (`claudePrintCommand(..., "json")`; 3-arg helper stays `--output-format
     text` for the existing unit-test contract). Cost-less text stdout
     (test fakes) leaves the sink uncalled. Ceiling/rate defaults imported
     from `subprocessProviders` (R350 / 18.5).

  Documented limitations (honest, not silently assumed):
  - Sandbox mid-turn tool calls go through HTTP broker (control-api), not
    in-process L1. Enforcement there is pre-turn + next-turn; same
    turn-granular TOCTOU as TASK-143.
  - `executeTaskRun` still has no `budgetTap` option; ALS is the live
    production binding until a later task can add the explicit option.

- [2026-09-07T04:35:00Z] [GB] Test evidence (this session, not recalled):

  `pnpm --filter @oikonomos/harness-factory test` — 17 files, 129/129 pass
  including `src/compose.test.ts` 9/9 (tap before yield, fail-closed sink,
  ALS production channel, L1 deny before broker, throwing check →
  `budget.check_failed`).

  `pnpm --filter @oikonomos/db test` — 37 files, 187 passed / 2 skipped.

  `pnpm --filter @oikonomos/worker test` (isolated) — 23 files, 142/142
  including:
  - in-source TASK-163: records 0.25 USD from a genuine-shaped SDK result
    on the local queryFn path; `platformCeilingZar: 0` denies before
    queryFn runs (`budget.platform_exceeded`, run `failed`); sandbox JSON
    stdout records +0.15 on the same routine (0.40 total).
  - existing `chatRunDriver.test.ts` 20/20 including two live TASK-116
    Agent SDK runs (~9s each).
  - `subprocessProviders.test.ts` 13/13 **unmodified** (TASK-143 Codex/Grok
    path unaffected).

  `pnpm -r build` exit 0. `pnpm lint` exit 0.

  `pnpm --no-bail -r test`: two failures, both out of this task's territory
  and previously flagged as flakes:
  - `services/worker/src/jobs/workerJobQueue.test.ts` pg-boss poll timing
    (`lastFireStatus: 'queued'`) — passed 6/6 on isolated retry.
  - `services/control-api/src/chat.routes.test.ts` group-thread
    `waiting_approval` wait (1s) — the `@everyone` path uses
    `requestGroupFanout` → `deliverBotToBotMessage`, which never calls
    `chatRunDriver` (and never parks). Not a TASK-163 regression.

## Stopping point

Ready for review. All five ACs met: SDK result cost captured (tested against
the live sdk.d.ts shape + TASK-116 genuine runs still green), spend recorded
in TASK-143's schema, broker `resolveBudgetGate` denies further tool calls
on the Claude path, TASK-143 tests unmodified and green, build/lint/package
suites green.

