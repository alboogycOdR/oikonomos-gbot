# ADR-012 — E10 (Organizational Memory Exchange) extends packages/memory, not a parallel org_facts store

**Status:** ACCEPTED · **Date:** 2026-09-02 · **Decision owner:** ORCH (scope authorized by Alister: "proceed with E9.1 and E10")
**Relates to:** Master WBS E10 (OIK-098–104); TASK-085 (packages/memory); TASK-090 (services/workspace mailbox); CLAUDE.md "canonical JSON + digest has exactly one implementation" convention

## 1. Context

The Master WBS's E10 (`OIK-098` "org_facts schema" through `OIK-104` "adversarial review") predates ADR-010's persistent-office pivot and specifies a standalone cross-role fact-exchange system: a dedicated `org_facts` table with an explicit per-fact ACL array, version/`superseded_by` chains, provenance, a "publish" API (no ambient sharing), an ACL-enforcing read API with a required negative test, typed handoff objects over pg-boss carrying fact *references* (not payload copies), and a two-role end-to-end demo.

Since that WBS was written, TASK-085 shipped `packages/memory` (three scopes — agent/project/user — three tiers, `resolve()` with a fixed `agent > project > user` conflict order, cross-role isolation on agent-scope facts) and TASK-090 shipped `services/workspace`'s `sendToRole` mailbox (async, workspace-paths-not-bytes, zero context/memory carry-over). Both are real, merged, independently verified substrate — not stubs.

They are not the same design as E10 asks for: memory's access control is scope-based (an enum + owning `role_id`/`project_id`), not an explicit per-fact ACL list; memory has no versioning or supersession; the mailbox carries free-text bodies, not typed fact references; nothing runs over pg-boss.

## 2. Decision

**E10 extends `packages/memory` and `services/workspace`'s mailbox. It does not stand up a parallel `org_facts` table or a second fact-storage system.** This follows the same "exactly one implementation" principle this project already applies to canonical JSON/digest (`packages/shared`) and the D3 root constant (ADR-011... no, TASK-097). Two storage layers for the same concept — "a fact one role wants another to see" — is exactly the kind of drift TASK-097 existed to close, not a pattern to introduce deliberately.

Concretely, in scope for E10's decompose (mechanism decided at task-cutting time, not here):

1. **ACL model:** `profile_facts` gains an explicit ACL — not a return to a free-text field, but a structured `visible_to` concept (e.g. an array of `role_id`s, or a `project`-scope fact's existing project membership) layered onto the existing scope enum, not replacing it. Agent-scope facts remain owner-only by construction (unchanged, already proven); the new ACL surface applies to project/user-scope facts, which today are readable by any role in the tenant with no finer control — OIK-100's negative test ("agent cannot read outside ACL scope") is new work here, not already covered by TASK-085's existing cross-role isolation test (that test proves agent-scope isolation, not general ACL enforcement).
2. **Versioning:** a `superseded_by` chain (or equivalent) added to `profile_facts`, so a corrected fact is a new row referencing the old one, not an overwrite — OIK-101's "why do you believe this, since when" bar requires history to exist at all, which it currently does not.
3. **Explicit publish, not ambient write:** `writeMemoryFact` already requires an explicit call (no ambient side-effect writes, proven by TASK-085's own liveness test) — this part of OIK-099 is already met and needs no new code, only confirming it in the E10 decompose rather than re-implementing it.
4. **Typed handoff:** `sendToRole`'s `body` gains a typed variant — a small closed set of handoff shapes (e.g. `research.complete`, `draft.ready_for_review`) that carry a memory **fact reference** (tenant/scope/role/key, not a copy of the value) alongside the existing free-text body, so the receiving role re-reads the fact live rather than trusting a stale copy. This is additive to `SendToRoleInput`, matching TASK-091's own additive-field precedent — existing untyped handoffs keep working unmodified.
5. **pg-boss:** OIK-102 specifies handoffs travel over pg-boss. TASK-076's scheduler already exists and is not pg-boss-based (Addendum F §6.3 deliberately kept it a plain in-process policy object, not a job queue). Re-platforming onto pg-boss is out of scope for this pass — the typed-handoff *shape* is what OIK-102 actually tests for (fact references, not payload copies); the transport (`role_messages` table, not a queue) already exists and works. This ADR does not authorize a pg-boss migration; if a future need for durable cross-process delivery emerges, that is its own decision.
6. **End-to-end demo + adversarial review (OIK-103/104):** a two-role handoff (e.g. research → drafting) carrying a typed, fact-referencing handoff, with a Fable-standard adversarial review of the ACL model specifically — reviewer model must differ from author model, per this project's every other protected-path precedent, even though `packages/memory` and `services/workspace` are not on the formal protected-paths list. Given this is a security-relevant ACL boundary (a real "can role B read role A's data" question), it gets the same rigor as a protected path by policy, not by the letter of the CLAUDE.md list.

## 3. What does NOT change

- Agent-scope isolation (owner-only, already proven) is unchanged — the new ACL surface is additive, applying to project/user scope only.
- `resolve()`'s fixed `agent > project > user` conflict order is unchanged.
- No new database beyond migrations extending the existing `profile_facts`/`role_messages` tables — no new package unless the decompose finds a real seam requiring one.
- `sendToRole`'s existing untyped contract (zero context carry-over, no implicit memory write, workspace-refs-not-bytes) is unchanged and remains the default; typed handoffs are additive.

## 4. Rollout

Decompose into concrete PLAN.md tasks now (this session), same rigor as ADR-011: real Owned_Paths, real acceptance criteria per OIK item, adversarial review on the ACL/versioning work specifically.
