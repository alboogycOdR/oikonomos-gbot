# TASK-095 — Gemini AgentProvider — Work Log (S5)

## Work Log

- [2026-09-02T09:40:00Z] [S5] Resumed on existing branch `task/TASK-095-s5` (claim-only commit
  already present, no code yet). Read AGENTS.md, PLAN.md TASK-095 block, `claudeCode.ts` (pattern
  to mirror), `grok.ts` (simpler single-shot pattern), `types.ts`, `config.ts`, `providers/index.ts`,
  `packages/harness-factory/src/providers/gemini.ts` (TASK-094's governed adapter — its `run()`
  returns `{ text, functionResponses, denied }`, no usage/session data, and requires an injected
  `PreToolUseHookPort`), and `packages/agent-providers/src/pricing.ts` (TASK-096's pure
  `costForUsage`).

  Implemented, strictly within Owned_Paths:
  - `src/providers/gemini.ts` — new `GeminiProvider`, mirroring `ClaudeCodeProvider`'s shape: a
    local stand-in `GeminiQueryFn` type (own interface, decoupled from harness-factory's adapter,
    same pattern as `ClaudeQueryFn`) is the entire injectable surface — no L1/broker port
    parameter anywhere in its signature, so it structurally cannot call `l1.handle()`. Translates
    the resolved `GeminiQueryResult` into `text_delta` (when non-empty) + `turn_complete`, with
    `costUsd` computed via TASK-096's `costForUsage` from `usageMetadata.promptTokenCount` /
    `candidatesTokenCount` (never null, 0 when usage is absent). Denial and thrown-error paths both
    yield a fatal `error` event; an already-aborted signal yields a non-fatal interrupted error.
  - `src/providers/gemini.test.ts` — 18 tests. **Important tooling finding**: this package's
    `vitest.config.ts` scopes `include` to `test/**/*.test.ts` only; colocated `src/**/*.test.ts`
    files (e.g. `budget.test.ts`, `pricing.test.ts`) only run because they're picked up via
    `includeSource: ["src/**/*.ts"]`, which requires the body to be wrapped in
    `if (import.meta.vitest) { ... }` — an unguarded top-level `describe/it` in a file under `src/`
    is silently never collected (verified empirically: a bare dummy `.test.ts` under `src/` never
    ran, with or without the guard fix). Wrote `gemini.test.ts` using that guard, confirmed all 18
    tests actually execute (`npx vitest run` → `src/providers/gemini.test.ts (18 tests)`), not just
    present-on-disk.
  - `src/types.ts` — added `"gemini"` to `ProviderId` and `PROVIDER_IDS`; `isProviderId` covers it
    for free (tested).
  - `src/config.ts` — added `GEMINI_API_KEY` (optional, same `optionalString` validation rigor as
    `ANTHROPIC_API_KEY`/`CODEX_API_KEY`/`XAI_API_KEY` — present+non-empty or `undefined`, never
    logged) and `GEMINI_MODEL` (defaulted `"gemini-3.7-flash"`, for `ProviderRegistry` construction
    parity with `CLAUDE_MODEL`/`CODEX_MODEL`/`GROK_MODEL`). Updated the `DEFAULT_PROVIDER` invalid-
    enum error message to list `gemini`. Tested in `gemini.test.ts` (config.ts has no owned test
    file of its own in this task's Owned_Paths, so its tests live alongside the provider's).
  - `src/providers/index.ts` — registered `gemini: new GeminiProvider({ defaultModel:
    config.GEMINI_MODEL })` in `ProviderRegistry` (constructed without a `queryFn`, matching
    `ClaudeCodeProvider`'s own "factory constructs, harness injects later" split), re-exported
    `GeminiProvider`/`GeminiProviderOptions`/`GeminiQueryFn`/`GeminiQueryResult`/
    `GeminiUsageMetadata`.
  - Confirmed `claudeCode.ts`, `codex.ts`, `grok.ts` are byte-identical to the branch point:
    `git diff --stat` against `main`'s merge-base shows zero changes to those three files (only
    `gemini.ts`/`gemini.test.ts` added, `types.ts`/`config.ts`/`providers/index.ts` modified).

  `pnpm test` (this package) — **18/18 new tests green, 96/96 total green** (10 files):
  ```
  ✓ src/providers/gemini.test.ts (18 tests) 32ms
  Test Files  10 passed (10)
       Tests  96 passed (96)
  ```

  **Blocked at typecheck.** `npx tsc --noEmit` in `packages/agent-providers` surfaces 3 new
  errors, all in `src/metadata.ts` (NOT in this task's Owned_Paths):
  ```
  src/metadata.ts(43,23): error TS2536: Type 'K' cannot be used to index type 'ProviderExtrasMap'.
  src/metadata.ts(50,4):  error TS2536: Type 'K' cannot be used to index type 'ProviderExtrasMap'.
  src/metadata.ts(61,10): error TS2536: Type 'K' cannot be used to index type 'ProviderExtrasMap'.
  ```
  Root cause: `metadata.ts`'s `ProviderExtrasMap` interface (TASK-072) explicitly enumerates only
  `"claude-code" | codex | grok` as keys, and `NamespacedProviderExtras`/`extrasFor`/
  `withProviderExtras` are generic over `K extends ProviderId`. Widening `ProviderId` to include
  `"gemini"` (required by this task's own first acceptance criterion) makes `ProviderExtrasMap[K]`
  ill-typed for `K = "gemini"` — `metadata.ts` is not exhaustive over `ProviderId` any more.
  Verified this is caused by my `types.ts` change and nothing else: `git stash -u` (full revert
  incl. untracked `gemini.ts`/`gemini.test.ts`) leaves `tsc --noEmit` with only one *pre-existing*,
  unrelated error (`src/pricing.test.ts(47,9): TS2578: Unused '@ts-expect-error'`, a TASK-096
  leftover, not mine to fix either).

  The fix is small and obvious (add a `gemini: Record<string, never>`-shaped entry, or equivalent,
  to `ProviderExtrasMap`, plus a `GeminiProviderExtras` interface mirroring
  `ClaudeCodeProviderExtras`/`CodexProviderExtras`/`GrokProviderExtras`) but **`metadata.ts` is not
  in this task's `Owned_Paths`**, and AGENTS.md commandment 4 / CLAUDE.md are explicit: "Not one
  line, not 'just an import'" — no exceptions for small or obvious fixes. Stopping here rather than
  touching it.

  Everything else is done and tested: full diff is `gemini.ts` (new), `gemini.test.ts` (new),
  `types.ts`, `config.ts`, `providers/index.ts` (all three within Owned_Paths). No commit made yet
  — holding the worktree dirty at the blocked checkpoint so the diff is inspectable as-is; will
  commit once unblocked (or on request).

## Status: blocked

**Blocked_Reason:** OWNERSHIP_CONFLICT — completing this task's own acceptance criterion #1
("gemini" added to `ProviderId`/`PROVIDER_IDS`) breaks `packages/agent-providers/src/metadata.ts`
typecheck (`TS2536` ×3, non-exhaustive `ProviderExtrasMap` over the widened `ProviderId`).
`metadata.ts` is not in TASK-095's `Owned_Paths`. Need either: (a) `metadata.ts` added to this
task's `Owned_Paths` so I can add the `gemini` entry to `ProviderExtrasMap` (and a
`GeminiProviderExtras` interface) myself, or (b) a small companion task/commit against
`metadata.ts` sequenced alongside this one, or (c) ORCH's own call if there's a preferred shape for
Gemini's extras namespace. All other Owned_Paths work (gemini.ts, gemini.test.ts, types.ts,
config.ts, providers/index.ts) is implemented and test-green; only this one file outside my
territory blocks a clean `pnpm -r test`/typecheck.
