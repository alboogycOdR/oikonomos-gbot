# TASK-062 - packages/approvals decision transitions (PROTECTED)

## Brief
`packages/approvals` can issue an approval and can `verifyAndConsume` an already-granted one — but has **no way to move `pending` to `granted` or `rejected`**. The human decision step has no API. That is the other half of the gap S5 found in TASK-056.

## Spec pointers
- N8 / OIK-022 — approvals are nonce-bound and single-use; consumption is **one atomic SQL statement**. Each new transition must follow the same shape as `CONSUME_APPROVAL_SQL`: status-guarded, row count 1 or it did not happen.
- OIK-023 — expired/invalidated rows must never become granted.
- OIK-086 — Approve/Reject is the surface's decision step; this is the API behind it.

## Intended approach
`decide.ts` with `grantApproval` / `rejectApproval` (or one `decideApproval`), SQL in `store.ts` alongside the existing statements.

**The separation that matters:** granting must NOT consume. Approve and use are two steps — a granted approval still has to go through `verifyAndConsume` to be spent. A test must prove it.

Additive only: existing consume/issue paths unchanged, existing tests byte-identical. Mutation to run: remove the status guard from the transition SQL and a test must go red.

**Protected path:** GB or CX only, never S5 (different-model review).

## Work Log
