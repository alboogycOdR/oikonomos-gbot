# TASK-092 — packages/connectors — durable tenant session pool: create/destroy becomes acquire/release

**Assigned_To:** S5 · **Depends_On:** —

## Brief

Give connector sessions a life longer than one run: a tenant-scoped pool where create/destroy becomes acquire/release, delivering the 'signed in once, available thereafter' property ADR-010 asks for.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §4.2 (F10), §6.2, §9 OIK-208; docs/decisions/ADR-010 §4 (signed in once, available thereafter); docs/research/grok-bot-live-probe-2026-09-01.md Q11

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`packages/connectors/src/sessions/**, packages/connectors/src/index.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

The pool sits UNDERNEATH the working manifest / enumeration / discovery-cache / mcp code from TASK-054 and TASK-083 — none of it is modified, and the review will diff those directories against master. Sessions are scoped by tenant, never by role: roles share sessions by design, which is exactly why a role is not a security boundary. The probe's Q11 contract is the security bar — the model gets an opaque handle, never a token.

## Work Log
