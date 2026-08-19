# TASK-058 - Telegram approval inline-keyboard (OIK-086) - the money shot

## Brief
A Tier-3 action parks, the phone shows what the agent wants to do, a tap decides it. Approve / Edit / Reject inline keyboard on a pending approval.

## Spec pointers
- OIK-086 - "Approve/Edit/Reject; **edit invalidates prior approval and re-enters cycle**".
- ADR-004 (render provenance) - render from the approval's **stored render**, never re-composed here. A surface that composes its own description can show the operator something different from what the digest binds.
- N8 / OIK-023 - nonce consumption belongs to `packages/approvals` via control-api; digest mismatch implies `invalidated`, new approval required.

## Intended approach
Approve/Reject POST to control-api's decide endpoint; this service contains **zero** nonce-consumption logic (mutation: add one, test goes red). Double-tap Approve must yield exactly one consumed approval. Do not embed the raw nonce in forwardable callback data - use an opaque handle, and document the mechanism in the work log.

## Work Log
