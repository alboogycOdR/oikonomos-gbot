# TASK-086 — packages/policy — EnforcementClass resolver + require-approval precedence ⚑ protected

**Assigned_To:** CX · **Depends_On:** —

## Brief

The tier-map rework as a pure function. `EnforcementClass = autonomous | enforced` becomes a second output alongside the existing tier, resolved by the six-rank total order in Addendum F §5.4.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §5.1 (F12), §5.2 (F13 enforced floor), §5.3 (F14), §5.4 (F15 precedence table), §9 OIK-202; docs/decisions/ADR-010 §6; ADR-003 (tier resolution direction)

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`packages/policy/src/enforcement.ts, packages/policy/src/enforcement.test.ts, packages/policy/src/requireApproval.ts, packages/policy/src/requireApproval.test.ts, packages/policy/src/index.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

PROTECTED PATH — CX only. `packages/policy` has zero I/O by lint rule, so rules arrive as data. Do not touch `resolveEffectiveTier`, `ceiling.ts` or the `RiskTier` enum: the tier stays and simply stops implying approval (F12). The floor (E1–E5) is the whole point — write its liveness test first, with a maximally permissive rule set, so you find out immediately if any code path can argue an E-class action into rank 6.

## Work Log
