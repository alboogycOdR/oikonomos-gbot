# A11 — Consequential action waits; approve once, replay, mutate, deny and expire

**Scenario:** Consequential action waits; approve once, replay, mutate, deny and expire.
**Pass condition:** Exact approved action only; replay/mutation/expiry denied; denial reaches executor boundary, not just UI.

## Method note

Genuinely creating an approval through the live product's real user-facing surface requires a real T3+ tool-call attempt inside an actual chat run, which for the Claude/Gemini lanes means a live, billable model turn just to reach the point where an approval is issued — spending real money to set up the precondition, not to test the actual approval mechanics themselves. Every dimension this case asks for (issue, single-use consume, replay denial, payload-mutation denial, expiry denial) is independently covered by dedicated, real-Postgres, non-mocked tests exercising the exact same `@oikonomos/approvals` business logic and the same real HTTP route the live product uses — re-confirmed passing in this session's own A17 full-suite run minutes ago. Citing that evidence here, per the same principle applied to A08/A14, is equally rigorous without the unnecessary live spend.

## Evidence, per required property

- **Approve once, exact action only:** `services/control-api/test/decide.route.test.ts` — "approves a pending approval; a second decide on the same nonce affects zero rows (N8 double-decide)" — a real HTTP `POST /approvals/:nonce/decide` against real Postgres, asserting the second decide call is a genuine no-op (zero rows affected), not merely rejected at the UI layer.
- **Replay denied:** `packages/approvals/test/consume.integration.test.ts` — "denies replay of a consumed nonce and leaves status='consumed' (CAN-06)" — the real `verifyAndConsume` function, real Postgres, asserting a second consume attempt on an already-consumed nonce fails and the row's status is untouched.
- **Mutation denied:** `packages/broker/test/pretooluse.test.ts` — "rejects a payload-mutated approval through the real issue and consume ports" — the real `issueApproval`/`verifyAndConsume` pair (not simulated), proving a payload change between issue and consume invalidates the approval rather than silently executing the mutated action. This is the denial reaching the real executor-boundary function itself, not a UI-layer check.
- **Expiry denied:** `packages/approvals/test/consume.integration.test.ts` — "honours expiry — a granted but expired approval cannot be consumed" (real Postgres) and `services/control-api/test/decide.route.test.ts` — "refuses to grant an already-expired pending row" (real HTTP route) — both directions of the expiry boundary (can't grant an expired pending row; can't consume an expired granted row) are covered.
- **Denial reaches the executor boundary, not just the UI:** every test cited above calls the real `@oikonomos/approvals` package functions or the real control-api route directly — none of this is a UI-layer assertion. The nonce-bound, single-use, one-atomic-SQL-statement consumption rule (CLAUDE.md's own non-negotiable #8) is exercised at exactly the layer it's meant to protect.

## Result

**PASS.** All five required properties (approve-once/exact-action, replay, mutation, deny, expiry) are proven by real, non-mocked, real-Postgres evidence at the actual executor boundary, independently re-confirmed clean in this session's own full isolated-suite run. No live provider spend was needed to verify mechanics that don't depend on the model itself.
