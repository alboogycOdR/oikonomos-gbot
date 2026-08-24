# TASK-063 - control-api atomic invalidate-and-reissue (Edit lifecycle)

## Brief
Add the one control-api operation TASK-058's Edit button needs and cannot have: invalidate an approval and issue a replacement bound to the edited payload. **This task exists because ORCH's decompose was wrong** — TASK-056 shipped six endpoints, none of which can edit an approval, while TASK-058's AC requires exactly that. CX blocked before writing code rather than build the lifecycle in the gateway. Right call.

## The primitives already exist — reuse them
`packages/approvals` exports:
- `ApprovalStore.invalidate(nonce)` — OIK-023's pinned, status-guarded SQL
- `issueApproval` — issues with nonce, digest, render, expiry

They were simply never surfaced through control-api. **Do not reimplement either**, and do not touch `packages/approvals` (protected) — consume its public API. Missing primitive ⇒ BLOCK SPEC_AMBIGUITY.

## The hazard to design against
A non-transactional implementation can leave the old row `pending` while the replacement is already issued — **two live nonces for one action, i.e. a double-approval path**. Equally bad in the other direction: invalidated with no replacement. Both legs go in one transaction; a forced mid-operation failure must leave the original untouched.

## ADR-004 is binding
The replacement's stored render must be regenerated from the **edited** payload, and its digest must bind that **same** edited payload. A render describing the old payload while the digest binds the new one is exactly the approve-one-thing-execute-another failure ADR-004 exists to prevent.

## Spec pointers
- OIK-086 — "edit invalidates prior approval and re-enters cycle"
- OIK-023 — invalidation on payload mutation
- OIK-084 — publish the route in the OpenAPI document; the Telegram lane codes against it
- N8 — nonce-bound, single-use

## Work Log
