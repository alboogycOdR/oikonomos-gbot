# TASK-014 — OIK-022 approvals verify + atomic consume (N8) ⚑ protected

**Brief:** The most security-critical function in the platform so far. Consumption is ONE atomic SQL statement; row count 1 or the action does not run.

**Spec pointers:** Handover §4.3 pins the exact statement (`UPDATE approvals SET status='consumed', consumed_at=now() WHERE nonce=$1 AND status='granted' AND expires_at>now() AND consumed_at IS NULL`). WBS OIK-022. N8. ADR-001 CAN-06 (replay denied).

**Intended approach:** No read-then-write, no check-then-update transaction, no application-level lock — the invariant must hold at the database. The concurrency test must use genuinely parallel connections racing one nonce; sequential calls that merely resemble a race do not demonstrate the property. Sequenced behind TASK-013 in the same territory.

## Work Log