# TASK-072 Dossier — packages/agent-providers budget hook + registration completeness + namespaced provider metadata

Unit: S5. Mode: control.mode=strict (dossier is the heartbeat; PLAN.md is not touched).

## Preflight evidence (c8b9872 filesystem check)

```
[preflight] TASK-072 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
[preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    packages/agent-providers/src/budget.ts  -> does not exist; parent packages/agent-providers/src/ exists
  NEW    packages/agent-providers/src/registration.ts  -> does not exist; parent packages/agent-providers/src/ exists
  NEW    packages/agent-providers/src/metadata.ts  -> does not exist; parent packages/agent-providers/src/ exists
  NEW    packages/agent-providers/src/budget.test.ts  -> does not exist; parent packages/agent-providers/src/ exists
  NEW    packages/agent-providers/src/registration.test.ts  -> does not exist; parent packages/agent-providers/src/ exists
  FILE   packages/agent-providers/src/index.ts  -> exists, 51 line(s), 1123 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

## Work Log

- [2026-08-31T23:50:00Z] [S5] Session start. Found no prior dossier and no `task/TASK-072-s5` branch — fresh start (a stale `.devteam/CHECKPOINT.md` referenced TASK-069, an already-merged prior task; deleted it). Created branch `task/TASK-072-s5` from HEAD (worktree tip after TASK-069 merge, at that time `5c25e31`). Ran preflight (above): all target files NEW under an existing `src/` dir; `src/index.ts` exists as the barrel to extend.

- [2026-08-31T23:55:00Z] [S5] Read `types.ts` (the `AgentProvider` contract + `ProviderEvent`/`TurnCompleteEvent` shapes) and `providers/index.ts` (the existing `ProviderRegistry`, which is **not** in Owned_Paths — lives in `providers/index.ts`). Key design decision: implement all three deltas as new, additive, standalone modules that compose over the existing provider objects rather than modifying `providers/*.ts` or `providers/index.ts` (out of territory) or `types.ts` (also out of territory). This matches the task description's "do not modify the three existing provider implementations beyond wiring" — the "wiring" is composition (`withBudgetSink(provider, sink)`), not edits to provider internals.

  - `budget.ts`: `BudgetSink` port + `withBudgetSink(provider, sink)` decorator. Wraps `sendPrompt` so every `turn_complete` event triggers `sink.report({provider, model, costUsd, tokens})` **before** the event is yielded to the caller. If the sink throws (sync or async), the generator throws `BudgetSinkError` instead of yielding `turn_complete` — fail closed, an unaccounted turn cannot succeed silently. Note: `TurnCompleteEvent` (in `types.ts`, out of territory) has no `tokens` field today, so `tokens` is currently always `null` in the report — documented in the doc comment; the shape is stable so the broker can consume it once a provider starts reporting real token counts. Built the wrapper as an explicit object literal (not `{...provider}`) because provider classes put their methods on the prototype, which a shallow spread would drop.
  - `registration.ts`: `assertProviderComplete()` (structural check against every `AgentProvider` member, throws typed `IncompleteProviderError` naming exactly which members are missing/undefined/null) + `ValidatingProviderRegistry` (a standalone registry — deliberately separate from `providers/index.ts`'s `ProviderRegistry`, which this task cannot edit — whose `register()` validates before storing, so an incomplete provider fails at registration, not on first `sendPrompt`).
  - `metadata.ts`: `NamespacedProviderExtras` mapped type (`{claude-code: {...}, codex: {...}, grok: {...}}`, all keys optional) + `extrasFor`/`withProviderExtras` helpers. Purely additive — does not touch `types.ts`'s shared types.
  - `index.ts` (owned, top-level barrel): added exports for all three new modules alongside the existing ones. Did not touch `providers/index.ts`.

- [2026-08-31T23:58:00Z] [S5] Test placement: `vitest.config.ts` (not owned) sets `include: ["test/**/*.test.ts"]`, so files literally at `src/*.test.ts` are not picked up by the `include` glob — but `includeSource: ["src/**/*.ts"]` is also set, and the repo already has precedent (`packages/approvals/src/*.test.ts`) for in-source-style `.test.ts` files under `src/` using the `if (import.meta.vitest) { ... }` guard, which vitest's includeSource mechanism picks up independent of `include`. Followed that exact precedent for `budget.test.ts` and `registration.test.ts`. `metadata.ts` (no dedicated test file in Owned_Paths) carries its own small in-source `if (import.meta.vitest)` block directly, verified picked up as `src/metadata.ts (3 tests)` in the run below.

- [2026-08-31T23:59:00Z] [S5] Implemented all three modules + tests + barrel export. Full evidence:
  - `pnpm test` (packages/agent-providers): **7 files, 63 tests passed**, 0 failed — includes the pre-existing `test/config.test.ts`, `test/security.test.ts`, `test/providers.codex.test.ts`, `test/providers.grok.test.ts` byte-identical and green, plus the three new files (`src/budget.test.ts` 7 tests, `src/registration.test.ts` 8 tests, `src/metadata.ts` 3 tests).
  - `pnpm typecheck` (packages/agent-providers): clean, no output, exit 0.
  - `pnpm -r test` (repo root, full recursive suite per CLAUDE.md DEVDEPARTMENT amendment): exit 0, every package/service/eval suite green (approvals, connectors, harness-factory, broker, control-api, worker, evals/golden, evals/harness, agent-providers, …). No failures anywhere.
  - `pnpm lint` (repo root, eslint .): exit 0, no findings.
  - `pnpm canaries` (repo root → evals/harness): exit 0, 11 files / 15 passed / 2 skipped, all CAN-0x liveness assertions green.

- [2026-08-31T23:59:30Z] [S5] Verified `git status --porcelain` shows only the six intended files (5 new + `index.ts` modified) — nothing outside `Owned_Paths` touched. Committed on `task/TASK-072-s5`: `feat(agent-providers): budget hook, registration completeness, namespaced provider metadata [TASK-072]`.

- [2026-09-01T00:02:00Z] [S5] Attempted to write this dossier and got firewall-blocked: `dossiers/TASK-072.md — you may only write your own active task's dossier`. Root cause: the worktree's own `PLAN.md` (versioned at the branch point) still showed TASK-072 `Status: pending`, because ORCH's claim commit (`chore(plan): claim TASK-072`, and a later `TASK-069 merge + S5 redispatch` log entry) had landed on the main checkout's `master` branch *after* my worktree branched, and the firewall's `activeTaskIdFor` fallback (no `.devteam/inflight/S5.json` present) reads Status from the worktree's own `PLAN.md`, requiring it to be in `{claimed, in_progress, needs_review}`. Fixed by `git rebase master` in my worktree (pulling the two coordination-only commits onto my branch — no PLAN.md edit made by me, just a rebase picking up ORCH/AUTOPILOT's existing commits) rather than editing PLAN.md myself. Re-verified after rebase: `PLAN.md` now shows `Status: claimed` for TASK-072; `git log` shows my one code commit on top of the two coordination commits; `git status --porcelain` clean. Re-confirmed nothing else changed by diffing my commit's file list — unchanged from before the rebase (only the 6 agent-providers files).

## Acceptance criteria self-check

- [x] Budget sink invoked exactly once per completed turn with cost+tokens; a throwing sink fails the turn — tested via injected fake sinks in `budget.test.ts` (sync throw, async-reject, exactly-once count, pass-through of non-turn_complete events, interrupt delegation, default-model fallback, null-costUsd normalization).
- [x] Registering a provider missing a contract member throws at registration naming the member — tested in `registration.test.ts` (multiple missing members, single missing member, `id`-missing case, `null` treated as missing).
- [x] Provider extras only reachable via the provider-keyed namespace; shared type unchanged — `metadata.ts` is additive only, `types.ts` untouched (confirmed via `git status`/diff), typecheck-asserted via `pnpm typecheck` passing with the new mapped type in place.
- [x] Existing agent-providers tests byte-identical and green — `test/config.test.ts`, `test/security.test.ts`, `test/providers.codex.test.ts`, `test/providers.grok.test.ts` untouched on disk, all green in the run above.
- [x] `pnpm -r test`, `pnpm lint`, `pnpm canaries` all exit 0 — confirmed above.

## Handoff

Status: needs_review. Branch: `task/TASK-072-s5`, one code commit rebased on top of `master` (includes ORCH's TASK-072 claim + TASK-069 redispatch-log commits, no PLAN.md edits made by S5). No open questions, no blockers. `providers/index.ts`'s existing `ProviderRegistry` was deliberately left unmodified (out of Owned_Paths); `ValidatingProviderRegistry` in `registration.ts` is an independent, opt-in registry a future task can wire in if/when `providers/index.ts` territory is reassigned.
