# ADR-007 — Replay window semantics: what OIK-028 idempotency guarantees, and for how long

**Status:** Accepted
**Date:** 2026-08-16
**Author:** ORCH
**Related:** ADR-001 §R2, CAN-08; `docs/architecture/OIKONOMOS_Build_Handover_Package_v1.0.md` §4.1; CLAUDE.md non-negotiable #3; PLAN.md TASK-017
**Supersedes:** nothing. Resolves an ambiguity ADR-001 R2 left open.

---

## 1. The conflict this resolves

ADR-001 R2 / CAN-08 require that L1 (the `PreToolUse` hook) and L3 (`canUseTool`) hitting the broker for the same `toolUseId` produce **one decision and one audit event**. Read literally and without a time bound, that requires remembering every `toolUseId` **forever** — an unbounded cache in a long-lived process, which is itself a defect (TASK-017 shipped exactly that and it was sent back).

Bounding the cache therefore does not merely optimise memory; it **narrows R2's guarantee**, and R2 does not say by how much. That is a conflict between an implementation necessity and an ADR, so per CLAUDE.md ("ADR for every decision that conflicts with an existing document") it needs deciding here rather than in a constant.

**A defence that was offered and does not hold, recorded so it is not re-proposed.** TASK-017's TTL was justified as expiring "with the hook timeout window", and ORCH initially accepted the reasoning that a gap beyond 10s is already a dead tool use because non-negotiable #3 denies anything over 10s. **That conflates two different quantities:**

- **Non-negotiable #3's 10s** is the *broker response deadline* — how long a single broker call may take before the caller fails closed.
- **R2's window** is the *L1→L3 interval* — how long between the PreToolUse hook returning a verdict and `canUseTool` firing for the same tool use.

Nothing bounds the second by the first. L1 can answer in 50 ms and L3 can fire later behind a slow model turn. The two numbers are unrelated, and reusing one to justify the other is reasoning that looks sound and is not.

## 2. Decision

**The replay guarantee is time-bounded, and the bound is derived from the L1→L3 interval, not from the broker response deadline.**

1. **Within the replay window**, a repeated `toolUseId` (scoped to tenant and role — see §3) returns the **cached decision verbatim**, with **no second audit event** and no recomputation. This is R2 as written.
2. **Beyond the replay window**, the broker **recomputes**. This produces a second decision and a second audit event for that `toolUseId`. This is an accepted, documented narrowing of R2 — not a violation to be discovered later in an incident.
3. **A recompute is not a safety hole, and that is why this narrowing is acceptable.** The recomputed decision re-runs *every* check — kill switch, role grant, ceiling, tier, T4, nonce. It cannot yield an authorisation the first decision would have denied on current policy. The exposure of a recompute is a **duplicate audit entry and a possibly-different verdict**, never a bypass. Indeed, where policy changed in the interval, the *newer* verdict is the more correct one.
4. **The window is a stated constant with a derivation, not a tuned number.** It is expressed in terms of the L1→L3 interval it bounds. Changing it is an amendment to this ADR, not an edit to a constant.

**Why not the alternative.** The tempting fix — keep the key and return a deterministic `deny` after expiry, so one `toolUseId` never yields two different allows — is **not implementable within a bounded cache**: once an entry is evicted there is no way to distinguish "expired" from "never seen", so the deny would have to apply to every unseen `toolUseId`, i.e. deny everything. Retaining keys to tell them apart re-creates the unbounded growth the bound exists to prevent. Rejected as unimplementable, not as undesirable.

## 3. Scope of the replay key

The replay key is `tenantId \0 roleId \0 toolUseId`, and **all three components are load-bearing**:

`toolUseId` originates in the harness/agent payload — the **untrusted** side of the boundary. Keyed on `toolUseId` alone (as first shipped in TASK-017), a second role in a different tenant with **no role grant at all** could reuse a `toolUseId` and receive the first role's ALLOW, with **no audit event written for it**. That was a live cross-tenant authorisation bypass, found in review before merge.

The structural lesson generalises beyond this cache and is the reason this section exists: **an idempotency or caching layer placed in front of an authorisation check inherits the duty to be scoped by everything that check is scoped by.** This is the same failure shape as non-negotiable #7 (ACL filter before vector similarity, never after) — authorisation defeated by a layer sitting in front of it rather than by a flaw in the check itself. Any future cache, memo, or short-circuit in the decision path must be keyed on tenant and principal, or it re-opens this door.

**Consequence for the interface:** `getRoleGrant(roleId, capabilityId)` currently takes no `tenantId`, so tenant scoping of the grant lookup rests entirely on the caller's adapter. That is a latent version of the same hazard one layer down and is tracked as a follow-up.

## 4. Requirements that follow

- The replay window's constant carries a comment stating it bounds the **L1→L3 interval** and citing this ADR. It must not cite non-negotiable #3.
- The cache bound (entry cap and eviction) is a **mechanical control** and therefore ships a liveness assertion per CLAUDE.md — a test that fails when eviction is inert, not merely when it is absent from config.
- **Eviction must never remove an entry whose decision is still in flight.** An unsettled entry evicted under cap pressure causes the same `toolUseId` to be computed twice concurrently, yielding two decisions, two audit events and two consume attempts on one nonce — split-brain, with which caller receives the ALLOW decided by a race. Non-negotiable #8 (atomic consume, row count 1) means only one attempt can succeed against the nonce, so there is no double side-effect; the defect is the contradictory pair of verdicts in the audit log and the racing outcome, not a double spend.
- Tenant isolation is tested **independently of role isolation**. A test that varies `tenantId` and `roleId` together cannot detect the removal of `tenantId` from the key.
- Post-expiry recomputation is **explicitly tested**, so the narrowing in §2.2 is a demonstrated property rather than an emergent one.

## 5. What this ADR does not decide

- The numeric value of the window. §2.4 requires it be derived and stated; picking it is implementation work under TASK-017.
- Whether `getRoleGrant` should take `tenantId` (§3) — a broader interface question, tracked separately.
- Whether L1 and L3 should share a decision across *process restarts* (i.e. a persisted rather than in-memory replay store). Out of scope; in-memory is sufficient while the broker is a single process, and this ADR should be revisited if it is ever horizontally scaled, because a per-instance cache gives no cross-instance guarantee at all.
