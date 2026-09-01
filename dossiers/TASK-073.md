# TASK-073 — packages/broker: refusal memory (denials stick per run, grants not retroactive)

## Brief

Grok Bot's densest control (study §Tier 1 item 5 / `local-tool-permission-controller.ts`): a denied action must stay denied for the rest of that run. A retrying agent re-asking the human is a nagging vector and a budget burn. Per-run in-process refusal memory in the broker decision path: (1) a denial records `(runId, tool, sha256(canonical target))`; a repeat is auto-denied with TASK-067 `modelGuidance` (already refused; a later permission change does not authorize it) without re-parking for approval. (2) Cap 512 entries per run; overflow saturates the run and auto-denies everything further (fail closed — forgetting would fail open). (3) Grant-widening is not retroactive: a policy/tier change to auto-allow applies only to actions initiated after the change (epoch compare).

**GB or CX only, NEVER S5** (protected path). Additive standalone module; `packages/broker/src/index.ts` is outside Owned_Paths — not wired into L1. Persistence across worker restarts is deliberately out of scope (a restart re-parks, which is safe — the failure direction is re-ASKING, not re-running).

## Spec pointers

- docs/STUDY-grok-bot-018.md §Tier 1 item 5 (refusal memory)
- Directive §4 N3 (fail closed), N8 (approvals remain nonce-bound; this module does not consume)
- TASK-067 `packages/broker/src/decision.ts` — `refusal.abandoned` / `refusal.saturated` catalog copy

## Work Log

- [2026-09-01T13:36:48Z] [GB] Start on dispatcher-claimed TASK-073. control.mode=strict: no PLAN.md writes. Created `task/TASK-073-gb` from detached HEAD `2d745e6` (TASK-068 merge). Preflight (c8b9872 filesystem check):
  ```
  [preflight] TASK-073 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    packages/broker/src/refusalMemory.ts  -> does not exist; parent packages/broker/src/ exists
    NEW    packages/broker/src/refusalMemory.test.ts  -> does not exist; parent packages/broker/src/ exists
  ```
  Both paths are new territory (parent `packages/broker/src/` exists). Will not touch `index.ts` (out of Owned_Paths); existing L1 tests stay byte-identical by construction. Baseline SHA-1 of files that must stay untouched:
  - `421b2777e4cb158e439d2e0e1514aba4938bf25a  packages/broker/src/index.ts`
  - `c13456a2ee73d2fbfbd33860d5af42fb21bffce4  packages/broker/src/decision.ts`
  - `41a0782a4284c29d6e665709a271e803fe0cd012  packages/broker/src/describe.ts`
  - `36d719c391c6e5b5460ea231eab202b74c1d8854  packages/broker/test/pretooluse.test.ts`
  - `0f1522ec8762bac43c88561cde859df24b78e899  packages/broker/src/recheck.ts`
  - `2ffa4257ea4ccb1bd16ee1bae75f3c592f6961e0  packages/broker/src/registry.ts`
  Next: implement `refusalMemory.ts` (per-run map, 512 cap with fail-closed saturation, grant epoch) composing TASK-067 `denyDecision`, then tests covering every AC including MUTATION-PROVEN.
- [2026-09-01T15:08:15Z] [CX] Resumed preserved commit `4a0371e` on `task/TASK-073-cx`; fresh preflight confirmed both owned source files exist. Completed the outstanding live mutation proof: temporarily bypassing `memory.consult(action)` made `pnpm --filter @oikonomos/broker test -- refusalMemory.test.ts` fail 4/12 assertions (repeat denial/no-second-ask, non-retroactive grant widening, and the explicit mutation test); restored the consult gate immediately. No production changes were needed beyond the preserved implementation. Persistence across worker restarts remains deliberately out of scope: a restart re-parks rather than re-runs, the safe direction. Validation after restoration: `pnpm --filter @oikonomos/broker test` 84/84 passed; `pnpm --filter @oikonomos/broker typecheck` passed; `pnpm -r test` passed; `pnpm lint` passed; `pnpm canaries` passed (17/17). `git diff --check` clean. Files outside the two owned broker paths remained untouched; this dossier is the strict-mode coordination exception.
