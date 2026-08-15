# TASK-017 — OIK-028/029/030 broker idempotency, fail-closed, kill switch ⚑ protected

**Brief:** The three properties that make the broker trustworthy under failure. Sequenced behind TASK-016 in the same territory.

**Spec pointers:** WBS OIK-028/029/030. ADR-001 R2 (idempotent per `toolUseId`), R3 (fail closed), CAN-04 (broker 500/timeout ⇒ deny + park), CAN-08 (one audit event for L1+L3).

**Intended approach:** Idempotency must REPLAY the stored decision, not recompute it — recomputing means a policy change mid-call could return two different answers for one tool use. Fail-closed cases (>10s timeout, 500, malformed body) each get their own test. The kill switch must be read per request, never cached at startup, since the acceptance says no restart is required.

## Work Log