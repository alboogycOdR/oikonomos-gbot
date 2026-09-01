# TASK-090 — services/workspace — shared workspace paths, durability-tier classification, handoff mailbox

**Assigned_To:** S5 · **Depends_On:** TASK-084

## Brief

Grow the `services/workspace` stub into the single place that understands the Office filesystem: path resolution, durability-tier classification, and the role-to-role handoff mailbox.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §4.1 (F9), §2.2 (tier classification), §3.5 (F8 handoff), §9 OIK-206; docs/research/grok-bot-live-probe-2026-09-01.md Q5

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`services/workspace/src/**, services/workspace/test/**, services/workspace/package.json, services/workspace/vitest.config.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

Role directories are a convention, not a boundary — there is a test that asserts role A CAN read role B's directory, because pretending otherwise is how a shared box gets mistaken for isolation. Tier classification is what makes N14 mechanical: a caller writing to D2 gets told the write will not survive a rebuild. The handoff shape comes straight from probe Q5, which tested it empirically: async, verbatim text plus sender identity, workspace paths not file bytes, zero context carry-over, no implicit memory write. A handoff carries no privilege.

## Work Log
