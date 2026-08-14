# TASK-007 — OIK-019 packages/policy risk-tier resolution (BACKLOG, TBD — GB or CX ONLY, never S5) ⚑ protected

**Brief:** Pure-function risk-tier resolution: more-restrictive-wins, unregistered ⇒ deny, 100% branch coverage. Protected path — assignment restricted to GB or CX so ORCH's opus review satisfies the different-model rule (directive §3).

**Spec pointers:** Handover §4.2 (effectiveTier = max(default_tier, roleGrantOverride); unregistered toolName ⇒ deny, audit capability.unregistered). WBS OIK-019. Directive §4 fail-closed. TASK-005's lint rule enforces the zero-I/O property mechanically.

**Intended approach:** Tier enum ordering utilities + resolve() over capability rows and role grants (passed in as plain data — no I/O). Exhaustive branch matrix test; Vitest coverage gate at 100% branches for this package.

## Work Log
