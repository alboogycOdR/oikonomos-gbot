# TASK-088 — packages/broker — D3 sealed-secret path guard (N13 enforcement + detection) ⚑ protected

**Assigned_To:** CX · **Depends_On:** TASK-087

## Brief

Layers 2 and 3 of N13: a broker guard that denies any tool call resolving to a D3 secret path — browser profile, cookie stores, connector tokens, CLI credentials — regardless of tier, grant or allow rule, and audits the attempt distinctly.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §4.3 (F11/N13), §2.2 (D3 tier), §9 OIK-204; docs/decisions/ADR-010 §6 (stricter than Grok Bot); docs/research/grok-bot-live-probe-2026-09-01.md Q11

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`packages/broker/src/secretPathGuard.ts, packages/broker/src/secretPathGuard.test.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

PROTECTED PATH — CX only. This is the place ADR-010 §6 requires OIKONOMOS to be stricter than Grok Bot, whose own instance called this 'the hole in model never holds secrets'. Layer 1 (the mount simply not existing) is TASK-089's; this is defence in depth plus detection. Normalise symlinks and parent segments BEFORE matching — a guard walkable with a `..` is not a guard. Never let a secret value reach a log, audit payload or fixture.

## Work Log
