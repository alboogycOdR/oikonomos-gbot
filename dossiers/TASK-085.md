# TASK-085 — packages/memory + migration 005 — three scopes, three tiers, one conflict order

**Assigned_To:** S5 · **Depends_On:** —

## Brief

Fill the `packages/memory` stub with the three-scope / three-tier memory model taken from the live Grok Bot probe: scopes `agent | project | user`, tiers `profile | log | note`, conflict order agent > project > user.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §3.3 (F6), §9 OIK-201; docs/research/grok-bot-live-probe-2026-09-01.md Q4; CLAUDE.md non-negotiable 7 (ACL before similarity)

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`infra/postgres/migrations/005_agent_memory.up.sql, infra/postgres/migrations/005_agent_memory.down.sql, packages/memory/src/**, packages/memory/package.json, packages/memory/vitest.config.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

Migration 005 EXTENDS `profile_facts` — do not build a parallel store; the existing table already carries tenant/scope/key/value/source/confidence/expires_at. The tier split exists for context budget: only `profile` is injected every turn. Two deliberate departures from Grok Bot: memory writes are never a side effect, and one role cannot read another role's agent-scope memory at all (they can on Grok Bot's shared disk — see probe Q4).

## Work Log
