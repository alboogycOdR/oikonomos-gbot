# TASK-064 - pending→invalidated primitive for Edit (PROTECTED)

## Brief
Add `invalidatePendingApproval(nonce)` — the one primitive the Edit lifecycle needs and `packages/approvals` doesn't have. **This exists because ORCH named a reuse primitive without checking its guard**; S5 blocked before writing code and cited file:line. Right call.

## The gap, precisely
`INVALIDATE_APPROVAL_SQL` (store.ts:39-40) is pinned:
```sql
WHERE nonce=$1 AND status='granted' AND consumed_at IS NULL
```
That is **OIK-023's control**: a payload mutated *after* approval was granted, so the approval dies. Its own tests prove it no-ops on pending.

**Edit acts on a pending approval** — Approve/Edit/Reject are offered pre-decision. So the existing primitive returns rowCount 0 for Edit's only valid input. `EXPIRE_PENDING_SQL` doesn't help: time-based, not nonce-scoped.

## What to build
One atomic statement mirroring GRANT/REJECT's guard shape:
```sql
WHERE nonce=$1 AND status='pending' AND expires_at>now() AND consumed_at IS NULL
```
Row count 1 or the transition did not happen (N8).

## Two things not to do
1. **Do not touch `INVALIDATE_APPROVAL_SQL`.** It is a live OIK-023 security control. This work is purely additive, and a test must prove the two paths stay disjoint — granted-path still no-ops on pending, new path no-ops on granted. Neither control may silently absorb the other's job.
2. **Do not reuse `rejectApproval`** (recorded so it isn't "simplified" to later). `rejected` = the operator declined. `invalidated` = the request became void and is being replaced. Collapsing them makes the audit trail misreport an edit as a rejection — and the audit trail is the product.

## Work Log
