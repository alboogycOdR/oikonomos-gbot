# TASK-010 — OIK-020 packages/policy role constraints ⚑ protected

**Brief:** Extend the TASK-007 tier resolver with rate-limit and domain constraint evaluation from `role_grants.constraints`. Pure functions, zero I/O, mechanically enforced by TASK-005's lint rule.

**Spec pointers:** WBS OIK-020 ("Rate limit and domain constraint each **independently** enforced and tested"). Handover §4.4 for the constraints shape — the inbox-triage seed TASK-006 wrote uses `{rate_per_hour: 40, domains: ["*"]}`. **ADR-003** is required reading: it documents a fail-open trap where a ceiling value was passed as a floor parameter; do not reproduce that shape with constraints.

**Intended approach:** Caller supplies current usage counts and target domain as plain data — no clock reads, no DB. Separate predicate per constraint so denial reasons stay distinguishable for audit. The 100%-branch coverage gate is live on this package and will fail the build on an uncovered branch.

## Work Log

- [2026-08-15T09:21:45Z] [GB] Session start on detached HEAD; created branch `task/TASK-010-gb`. Preflight (c8b9872):
  ```
  [preflight] TASK-010 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   packages/policy/src/**  -> 1 file(s):
             packages/policy/src/index.ts
    GLOB   packages/policy/test/**  -> 1 file(s):
             packages/policy/test/risk-tier.test.ts
  ```
  Spec read: Handover §4.4 constraints shape, WBS OIK-020 independence requirement, ADR-003 fail-open trap (constraints stay independent predicates; no max_tier-as-floor shape). Implementing two pure evaluators + independent tests.

- [2026-08-15T09:24:00Z] [GB] Implemented `evaluateRateLimitConstraint` and `evaluateDomainConstraint` in `packages/policy/src/index.ts` with stable denial reasons `constraint.rate_per_hour` / `constraint.domains`. Added `packages/policy/test/role-constraints.test.ts` (12 tests): rate and domain each enforced alone, `["*"]` wildcard allow, non-matching domain deny, empty allowlist fail-closed, distinguishable reasons. Verification:
  - `pnpm --filter @oikonomos/policy test` → 21/21 pass (9 risk-tier + 12 constraints), coverage 100/100/100/100 on index.ts
  - `pnpm --filter @oikonomos/policy typecheck` → exit 0
  - `pnpm lint` → exit 0 (policy-no-io clean)
  Handing off needs_review.
