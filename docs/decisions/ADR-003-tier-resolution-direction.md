# ADR-003 — Tier resolution direction: `max()` is more-restrictive, and `role_grants.max_tier` must never be fed to it raw

**Status:** ACCEPTED · **Date:** 2026-08-15
**Decision owner:** Alister Witbooi · **Raised by:** ORCH (opus-4-8) adversarial review of TASK-007 / OIK-019
**Resolves:** direct contradiction between Build Handover Package v1.0 §4.2 and Platform Synthesis Spec v0.1 §5.1

---

## Context

Two source documents specify the tier-resolution direction, and they say opposite things:

| Document | Text | Direction |
|---|---|---|
| **Build Handover §4.2** | `effectiveTier = max(capabilities.default_tier, roleGrantOverride)` — "the **more restrictive** wins. No path grants a role a lower tier than a capability's default." | Raises the tier |
| **Synthesis Spec §5.1** | `role_grants.max_tier` column commented as "role ceiling; broker takes `min(default, ceiling)`" | Lowers the tier |

CLAUDE.md's precedence order is unambiguous — Build Handover v1.0 outranks Synthesis Spec v0.1 — but the rule also says a conflict no ADR covers must halt the ticket and raise an ADR. TASK-007 implemented `max()` correctly per precedence; this ADR records *why* so the question is not relitigated, and captures the far more dangerous half of the finding.

## Decision

1. **`max()` governs.** `effectiveTier = max(capabilities.default_tier, roleGrantOverride)`, where the tier enum is ordered `T0_observe < T1_draft < T2_internal < T3_external < T4_irreversible`. A role grant can only make an action *more* restricted, never less. Synthesis §5.1's `min(default, ceiling)` comment is **superseded**.
2. **Unregistered capability ⇒ deny**, independent of any grant (Handover §4.2, N3).
3. **`role_grants.max_tier` is NOT `roleGrantOverride`.** This is the load-bearing part. The database column is *named and documented as a ceiling* — a value intended to cap a tier downward. The resolver parameter it superficially matches expects a *floor* — a value that raises the tier. Passing the column into the function directly type-checks, runs, and silently **fails open**: a role recorded as "capped at T1_draft" against a capability whose `default_tier` is `T3_external` would resolve to `max(T3, T1) = T3_external` and execute an external-impact action that the grant was written to forbid.

   Therefore any code that wires persisted role grants into policy resolution **must** convert explicitly, and the conversion must be tested with a case where the two semantics disagree (ceiling below default). The column is not renamed here because it is already live in the TASK-002 schema and Synthesis §5.1 remains authoritative for the schema itself; the conversion is the enforcement point.

## Consequences

- **Positive:** the direction is settled and the contradiction is closed. `packages/policy` (TASK-007) needs no change.
- **Risk retained, and it is a fail-open one:** the trap is invisible at the type level, because both sides are the same `risk_tier` enum. The compiler cannot catch it, the lint rules cannot catch it, and a passing test suite that never exercises "ceiling below default" will not catch it either.
- **Binding on future work:** the broker/role-grant wiring ticket (OIK-027 and the `role_grants` read path) must (a) convert `max_tier` semantics explicitly at the boundary, (b) carry a negative test where a ceiling *below* the capability default still denies, and (c) reference this ADR in that test's description. A reviewer seeing `max(default, row.max_tier)` in a diff should treat it as a defect on sight.

## References

- `docs/architecture/OIKONOMOS_Build_Handover_Package_v1.0.md` §4.2 — capability → tier resolution
- `docs/architecture/OIKONOMOS_Platform_Synthesis_Spec_v0.1.md` §5.1 — `role_grants` schema (authoritative for the schema, superseded on resolution direction)
- ADR-001 — fail-closed posture (N3); this ADR names a concrete fail-open path to avoid
- PLAN.md TASK-007 `Review_Findings` (2026-08-15T06:24Z) — where the contradiction was found
