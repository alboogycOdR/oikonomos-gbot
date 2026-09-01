# TASK-091 — packages/harness-factory — additive environment binding in ComposeOptions ⚑ protected

**Assigned_To:** CX · **Depends_On:** TASK-090, TASK-092

## Brief

One optional field on `ComposeOptions` — `environment` — and nothing else. This is the whole harness-factory migration, because persistence belongs to the substrate, not the harness object.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §6.1, §6 preamble (persistence belongs to the substrate, not the harness object), §9 OIK-207; docs/decisions/ADR-010 §4 (migration path, not a rewrite); ADR-001

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`packages/harness-factory/src/environment.ts, packages/harness-factory/src/compose.ts, packages/harness-factory/src/index.ts, packages/harness-factory/test/environment.test.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

PROTECTED PATH — CX only. The acceptance bar is that omitting the field yields today's behaviour exactly: every existing test and canary passes with zero edits. If you find yourself changing an existing test, stop — that is the signal the change stopped being additive. Do not make `composeHarness` long-lived; it may still be composed per run. The L1/L2/L3 layering, PreToolUse seam, fail-closed map and tool decorators are untouched.

## Work Log
