# TASK-201 Work Log

- [2026-09-06T19:20:00Z] [GB] Resumed dispatcher-claimed branch `task/TASK-201-gb` (already checked out; `git rev-parse --verify` → `0a3e1f721627e30fc1a18ea2a076ed825a2d0f9e`). Review_Findings empty — greenfield, not rework. Preflight (verbatim):

```
[preflight] TASK-201 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   packages/harness-factory/src/index.ts  -> exists, 405 line(s), 12025 bytes
  FILE   packages/harness-factory/src/index.test.ts  -> exists, 106 line(s), 3754 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  SDK investigation: installed `@anthropic-ai/claude-agent-sdk` (`^0.3.233`) `sdk.d.ts` declares `export declare function query(_params: { prompt: ...; options?: Options }): Query` and `Options.model?: string` ("Claude model to use. Defaults to the CLI default model."). Key name is `model`, matching the CLI flag. TASK-170 comment style read from `wt-codex9-GROKBOT-CLONE/services/worker/src/chatRunDriver.ts` (`OIKONOMOS_SANDBOX_MODEL` + CLAUDE.md Budget / R350 ceiling). Implementing `withDefaultModel` composed around `withSystemClaudeExecutable` so an explicit executable early-return still gets the model pin.

- [2026-09-06T19:25:00Z] [GB] Implemented `withDefaultModel` on the default SDK path (`lazySdkQuery` → `withDefaultModel(withSystemClaudeExecutable(input))`). Default `claude-haiku-4-5-20251001`; never overwrites caller `options.model`; override via `OIKONOMOS_HOST_MODEL` (whitespace treated as unset). Comment references CLAUDE.md Budget, matching TASK-170. Tests in `index.test.ts`: cheap default, explicit caller model preserved, composition with caller executable, env override, env cannot beat caller model, whitespace fallback, source-comment liveness.

- [2026-09-06T19:30:00Z] [GB] Verification: `pnpm --filter @oikonomos/harness-factory test` 16 files / 120 tests passed (index.test.ts 12/12). `pnpm lint` exit 0. `pnpm -r build` exit 0 (after local `pnpm install` restored stale control-api workspace links; no lockfile change). `pnpm -r test` exit 1 on pre-existing out-of-territory failures identical in kind to TASK-198: `packages/db` `messages.test.ts` thread_members FK cleanup + `roles.test.ts` deadlock. Retry excluding db (`pnpm -r --filter '!@oikonomos/db' test`) still hit an unrelated flaky `services/worker` pg-boss test (`lastFireStatus` expected `queued`, got `missed`); harness-factory in that run was 16/16 files, 120/120 tests, Done. No further in-territory work. Ready for needs_review; adversarial review of `packages/harness-factory/**` is ORCH's (different model than GB).
