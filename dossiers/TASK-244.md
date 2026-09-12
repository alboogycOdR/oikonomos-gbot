# TASK-244 — Workspace-1 — Gemini lane: terminate the turn immediately on human_takeover_required, incl. batched tools and retries; spend.unrecorded on failure path (protected path)

**Unit:** CX9 · **Priority:** medium · **Depends_On:** —

## Brief
Today `onHumanTakeover` only sets a closure flag (`chatRunDriver.ts:648-669`) checked after `await adapter.run(prompt)` returns (`:700,:744`), because `gemini.ts`'s `functionResponseFor` swallows tool exceptions; `geminiToolExecutors.ts:197-217` documents the window in which the model can issue one more tool call. Within one batch nothing re-checks the flag between executions (`:486-489, :517-520, :562-565`). Also the comment claims the audit event is recorded immediately; it is recorded only in the outer catch (`chatRunDriver.ts:480-487`). Required: a terminal signal path from executor → provider loop that stops dispatch of any remaining tool in the batch and any retry, ends the turn, and records the `human_takeover_required` audit event at detection. Keep the T2 ceiling and stage limits untouched. Fold in §7.4: emit the `spend.unrecorded` marker on the failure path as well as success (`chatRunDriver.ts:431,458`). PROTECTED PATH (`packages/harness-factory/**`): author CX9 (GPT); review by ORCH on an Anthropic model satisfies the different-model rule; the review must include an adversarial pass on whether any route remains for a tool call after detection. Independent of the dashboard tasks; dispatch after CX9's Workspace-1 API tasks unless capacity appears earlier.

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §9.1, §7.4; ADR-010 §6 enforced set; CLAUDE.md protected paths and different-model review; ADR-005

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
Today `onHumanTakeover` only sets a closure flag (`chatRunDriver.ts:648-669`) checked after `await adapter.run(prompt)` returns (`:700,:744`), because `gemini.ts`'s `functionResponseFor` swallows tool exceptions; `geminiToolExecutors.ts:197-217` documents the window in which the model can issue one more tool call. Within one batch nothing re-checks the flag between executions (`:486-489, :517-520, :562-565`). Also the comment claims the audit event is recorded immediately; it is recorded only in the outer catch (`chatRunDriver.ts:480-487`). Required: a terminal signal path from executor → provider loop that stops dispatch of any remaining tool in the batch and any retry, ends the turn, and records the `human_takeover_required` audit event at detection. Keep the T2 ceiling and stage limits untouched. Fold in §7.4: emit the `spend.unrecorded` marker on the failure path as well as success (`chatRunDriver.ts:431,458`). PROTECTED PATH (`packages/harness-factory/**`): author CX9 (GPT); review by ORCH on an Anthropic model satisfies the different-model rule; the review must include an adversarial pass on whether any route remains for a tool call after detection. Independent of the dashboard tasks; dispatch after CX9's Workspace-1 API tasks unless capacity appears earlier.

## Owned_Paths
packages/harness-factory/src/providers/gemini.ts, packages/harness-factory/src/providers/gemini.test.ts, services/worker/src/geminiToolExecutors.ts, services/worker/src/geminiToolExecutors.test.ts, services/worker/src/chatRunDriver.ts, services/worker/src/chatRunDriver.test.ts

## Work Log
