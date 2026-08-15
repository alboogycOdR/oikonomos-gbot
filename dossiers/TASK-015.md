# TASK-015 — OIK-023 + OIK-024 approvals invalidation + expiry sweeper ⚑ protected

**Brief:** Payload mutation after grant invalidates the approval; expired pending approvals are swept idempotently.

**Spec pointers:** WBS OIK-023, OIK-024. ADR-001 CAN-07 (mutate-after-approval must fail). Two finishers combined because they share territory and neither fills a session alone.

**Intended approach:** Recompute the digest at consume time and compare; mismatch ⇒ `invalidated`, and an invalidated approval must not be consumable even with a valid nonce. The sweeper must be safe run twice and safe run concurrently with itself.

## Work Log