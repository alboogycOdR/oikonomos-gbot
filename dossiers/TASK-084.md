# TASK-084 — packages/db + migration 004 — role identity, routines, messages, require-approval rules (D0 schema)

**Assigned_To:** S5 · **Depends_On:** —

## Brief

Turn `role_id` from free text into a real D0 identity. Migration 004 creates `roles`, `role_routines`, `role_messages` and `require_approval_rules`, wires FKs from the existing `role_grants.role_id` and `tasks.routine_id`, and ships a typed query layer. Everything else in the ADR-010 wave depends on these rows existing.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §3.1 (F4 roles table), §3.4 (F7 role_routines), §3.5 (F8 role_messages), §5.4 (F15 require_approval_rules), §9 OIK-200; docs/decisions/ADR-010 §2.2

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`infra/postgres/migrations/004_roles_routines_rules.up.sql, infra/postgres/migrations/004_roles_routines_rules.down.sql, packages/db/src/roles.ts, packages/db/src/roles.test.ts, packages/db/src/routines.ts, packages/db/src/routines.test.ts, packages/db/src/roleMessages.ts, packages/db/src/roleMessages.test.ts, packages/db/src/requireApprovalRules.ts, packages/db/src/requireApprovalRules.test.ts, packages/db/src/index.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

Read Addendum F §3.1, §3.4, §3.5 and §5.4 for the exact column lists — they are specified, not left to judgment. Start with the migration and its down-reverse test, then one query module per table. The backfill guard is the part most likely to bite: real rows already reference role_ids with no row behind them, and a migration that errors on them is a migration that cannot run. N12 lands here first — `roles.description` is prompt material, never an authorization input.

## Work Log
