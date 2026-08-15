# TASK-013 — OIK-021 approvals issue + bind ⚑ protected

**Brief:** Issue an approval carrying digest, render, destination, nonce and expiry — persisted **before** the agent is told to wait.

**Spec pointers:** Handover §4.3 (binding contract, canonical JSON + sha256). WBS OIK-021. Synthesis §5.1 (`approvals` table). N10 — `packages/shared` owns the only canonical-JSON/digest implementation; importing it is mandatory and a second implementation is automatic rework.

**Intended approach:** Persist-then-signal ordering, with a test that proves the ordering rather than assuming it — a crash between signalling and writing would strand a run against an approval that does not exist. Nonces from a CSPRNG, never `Math.random` or a counter.

## Work Log