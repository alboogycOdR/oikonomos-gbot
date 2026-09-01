# TASK-067 — packages/broker: describe-or-deny + model-directed denial guidance

## Brief

Two Grok Bot permission-machinery adoptions (study §Tier 1.2 and §Tier 1.5). (1) Undescribable ⇒ denied: a tool call the broker cannot render into `{action, target}` via a registered describer is refused when the decision tier requires human approval — if we cannot show it to a human we cannot ask, therefore we do not run it. Undefined from the describer MUST deny; target >10,000 chars is unpresentable. Composes with ADR-004: the stored approval render comes from this describe step. (2) Model-directed denials: deny decisions carry `{code, humanReason, modelGuidance}` so the calling agent is told what happened, that retrying is futile, and what to do instead.

**GB or CX only, NEVER S5** (protected path). Additive: existing allow/deny semantics unchanged; existing tests byte-identical. `packages/broker/src/index.ts` is outside Owned_Paths — modules are standalone; L1 wiring is a later task.

## Spec pointers

- docs/STUDY-grok-bot-018.md §Tier 1 items 2 and 5
- Directive §4 N3 (fail closed)
- ADR-004 (render provenance)

## Work Log

- [2026-09-01T12:45:00Z] [GB] Start on dispatcher-claimed TASK-067. control.mode=strict: no PLAN.md writes. Created `task/TASK-067-gb` from detached HEAD `2ba7eee` (TASK-066 merge). Preflight (c8b9872 filesystem check):
  ```
  [preflight] TASK-067 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    packages/broker/src/describe.ts  -> does not exist; parent packages/broker/src/ exists
    NEW    packages/broker/src/describe.test.ts  -> does not exist; parent packages/broker/src/ exists
    NEW    packages/broker/src/decision.ts  -> does not exist; parent packages/broker/src/ exists
    NEW    packages/broker/src/decision.test.ts  -> does not exist; parent packages/broker/src/ exists
  ```
  All four paths are new territory (parent `packages/broker/src/` exists). Will not touch `index.ts` (out of Owned_Paths); existing L1 tests stay byte-identical by construction. Baseline SHA-1 of files that must stay untouched:
  - `b7ee5b87070ce9c2d4773d8e1e8dff824ae716da  packages/broker/test/pretooluse.test.ts`
  - `ec296425464222545cb12782e4d1b687e02d7bdd  packages/broker/src/recheck.test.ts`
  - `e8c7de1c3b27027c8048f5a6ed71fedefdc26b32  packages/broker/src/registry.test.ts`
  - `588cd0c75ecf339a2aa9dca573fd05053365dfee  packages/broker/src/index.ts`
  Next: implement `decision.ts` (deny shape + closed guidance catalog) then `describe.ts` (whitelist describer + describe-or-deny).

- [2026-09-01T12:50:40Z] [GB] Implementation complete on `task/TASK-067-gb`. Did not touch `index.ts` (outside Owned_Paths); L1 `handlePreToolUse` unchanged. Existing broker tests byte-identical (SHA-1 unchanged vs session start).

  **Code**
  - `packages/broker/src/decision.ts` — closed 12-code catalog (SAND_LOCAL_TOOLS_* count). `denyDecision(code)` is the only constructor; shape `{decision:"deny", code, humanReason, modelGuidance}`. Every `modelGuidance` states what happened, "Do not retry", and an alternative. Unknown codes fail closed to `describe.undescribable`. `allowlist.miss` reuses TASK-066's `ALLOWLIST_MISS_REASON`.
  - `packages/broker/src/describe.ts` — whitelist describer registry (Map or Record, `Object.hasOwn`). Unknown / undefined / throw / malformed ⇒ `undefined`. `describeOrDeny` denies `describe.undescribable` when undefined (every approval-requiring tier T3/T4, and T0–T2 as N3 fail-closed default). Target >10,000 chars ⇒ `describe.unpresentable`. `{action, target}` is the ADR-004 describe step; `formatDescribedAction` is the stored-render formatter.
  - Tests: `decision.test.ts` (8), `describe.test.ts` (19, including MUTATION-PROVEN source-pin of the undefined branch plus behavioral deny).

  **Not wired into L1.** `handlePreToolUse` stays as TASK-066 left it. Callers (TASK-073 refusal memory, later L1 compose) import `./decision.js` / `./describe.js` directly. Re-export from `index.ts` would be OWNERSHIP_CONFLICT.

  **Test_Evidence**
  - `pnpm --filter @oikonomos/broker test` — 5 files, 72/72 pass (28 L1 + 8 registry + 9 recheck + 8 decision + 19 describe).
  - `pnpm --filter @oikonomos/broker typecheck` — exit 0.
  - `pnpm lint` — exit 0.
  - `pnpm canaries` — 15 passed | 2 skipped (17).
  - `pnpm -r test` — exit 0.
  - Existing file SHA-1 identical: `pretooluse.test.ts` b7ee5b87…, `recheck.test.ts` ec296425…, `registry.test.ts` e8c7de1c…, `index.ts` 588cd0c7…, `recheck.ts` afb0ad3e…, `registry.ts` 62b1058c….

  Ready for review.
