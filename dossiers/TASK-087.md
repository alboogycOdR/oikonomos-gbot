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

- [2026-09-01T20:28:00Z] [CX] Started on `task/TASK-087-cx`. Preflight: `packages/broker/src/enforcementGate.ts` NEW; `packages/broker/src/enforcementGate.test.ts` NEW; `packages/broker/src/decision.ts` FILE (162 lines); `packages/broker/src/decision.test.ts` FILE (90 lines); `packages/broker/src/index.ts` FILE (431 lines). Read Addendum F §§0, 5.1, 5.4, 9; ADR-001; ADR-010 §§3, 6; and the full prior dossier (empty work log). Implementing the gate at the existing `handlePreToolUse` L1 path without replacing its fail-closed mapping.
- [2026-09-01T20:29:12Z] [CX] Completed enforcement-gate wiring in `packages/broker/src/`: migrated capabilities opt into the policy resolver at L1; autonomous allows carry `enforcementClass` and `enforcementRank` in their audit payload; E1/rule/ceiling enforcement retains the existing nonce-bound approval port; E2 returns `human.takeover` without issuing approval; pre-existing refusal memory stops repeat approval issuance. The existing validation/failure map remains ahead of the gate. Added 9 direct gate/L1 tests, including a payment bypass liveness canary. Verified: `pnpm --filter @oikonomos/broker typecheck` (pass); `pnpm --filter @oikonomos/broker test` (93/93 pass); `pnpm lint` (pass); `pnpm canaries` (11 files pass, 15 pass/2 skipped); `pnpm -r test` (workspace pass); `git diff --check` (pass).
