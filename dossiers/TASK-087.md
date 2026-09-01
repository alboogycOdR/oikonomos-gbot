# TASK-087 — packages/broker — enforcement gate in the decision path ⚑ protected

**Assigned_To:** CX · **Depends_On:** TASK-086, TASK-073

## Brief

Wire TASK-086's resolver into the broker decision path so the broadened autonomy default is what the `PreToolUse` hook actually enforces, and so every autonomous execution says in the audit trail why it was allowed.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §5.1, §5.4, §9 OIK-203; docs/decisions/ADR-001-broker-enforcement-point.md; ADR-010 §3

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`packages/broker/src/enforcementGate.ts, packages/broker/src/enforcementGate.test.ts, packages/broker/src/decision.ts, packages/broker/src/decision.test.ts, packages/broker/src/index.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

PROTECTED PATH — CX only. ADR-001 is untouched: same enforcement point, same fail-closed map. Rank 1 of the precedence order must be satisfied by the EXISTING fail-closed map — a second parallel mapper is a review rejection. TASK-073's refusal memory is consumed at rank 4 exactly as built. The liveness canary is the one that matters: bypass the gate and a payment action must execute, proving the gate is load-bearing.

## Work Log
