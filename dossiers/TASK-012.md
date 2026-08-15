# TASK-012 — OIK-026 packages/audit redaction middleware (N4)

**Brief:** Strip secret patterns from audit payloads **before** they are written. Shares TASK-011's territory and is sequenced behind it by Depends_On, so the two are never concurrent.

**Spec pointers:** WBS OIK-026 ("Secret patterns stripped pre-write; unit-tested against fixture corpus"). Gap Closure §2 (evidence quality bar). N4.

**Intended approach:** Mirror the pattern families `hooks/secret-scan.js` already detects (API keys, private key blocks, AWS access key IDs) so the two layers agree on what a secret looks like — but write your own placeholder-marked fixtures. Do not copy the pack's realistic-looking ones; that file is scanner-exempt precisely because they look real. Assert on the persisted row, not the middleware's return value, and prove nested payloads are covered.

## Work Log