# TASK-089 — infra/compose — the Office: durable environment, named volumes, durability canary

**Assigned_To:** S5 · **Depends_On:** —

## Brief

Build the Office: a long-lived per-tenant container whose durable state lives on named volumes, with the four lifecycle verbs (provision / rebuild / recover / restore) and — the centre of the task — a durability canary that proves the tiers behave.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §2.1 (F1), §2.2 (F2 durability tiers + canary), §2.3 (F3 lifecycle verbs), §4.3 layer 1, §9 OIK-205; CLAUDE.md control-liveness; docs/decisions/ADR-005-control-liveness.md

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`infra/compose/docker-compose.office.yml, infra/compose/office/**`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

The strongest control in the whole design is an omission: `oikonomos-secrets` is not mounted into the model container at all. Prove it from inside that container. The durability canary must survive a REAL rebuild and assert both halves — D1 marker present with an identical digest, D2 marker gone. Checking that the compose file lists a volume is the inert-control failure ADR-005 exists for and will be rejected. There is no checkpoint/resume (probe Q3): in-flight work is cancelled, never suspended.

## Work Log
