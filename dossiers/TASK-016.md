# TASK-016 — OIK-027 broker PreToolUse handler ⚑ protected

**Brief:** The decision handler behind `POST /v1/broker/pretooluse`, as a library function. Composes policy + approvals + audit. Every request audited, allow or deny.

**Spec pointers:** Handover §4.1 (request and the three response shapes, verbatim — match field for field), §4.2 (tier resolution, unregistered ⇒ deny). ADR-001 (L1 is the enforcement point). **ADR-003 — the known trap.**

**Intended approach:** No web framework; the HTTP surface is OIK-084/E9. Convert `role_grants.max_tier` explicitly at the boundary: it is a CEILING and the resolver parameter is a FLOOR, and passing it straight through type-checks, runs, and fails OPEN (a T1-capped role against a T3 capability would resolve to T3). Carry the ADR-003 negative test with the ceiling below the capability default.

## Work Log