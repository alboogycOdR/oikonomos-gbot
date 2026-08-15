# TASK-010 — OIK-020 packages/policy role constraints ⚑ protected

**Brief:** Extend the TASK-007 tier resolver with rate-limit and domain constraint evaluation from `role_grants.constraints`. Pure functions, zero I/O, mechanically enforced by TASK-005's lint rule.

**Spec pointers:** WBS OIK-020 ("Rate limit and domain constraint each **independently** enforced and tested"). Handover §4.4 for the constraints shape — the inbox-triage seed TASK-006 wrote uses `{rate_per_hour: 40, domains: ["*"]}`. **ADR-003** is required reading: it documents a fail-open trap where a ceiling value was passed as a floor parameter; do not reproduce that shape with constraints.

**Intended approach:** Caller supplies current usage counts and target domain as plain data — no clock reads, no DB. Separate predicate per constraint so denial reasons stay distinguishable for audit. The 100%-branch coverage gate is live on this package and will fail the build on an uncovered branch.

## Work Log