# TASK-006 — OIK-014/016 packages/db typed layer + seed (BACKLOG, TBD)

**Brief:** Typed query layer over the TASK-002 schema with pooling limits, plus the idempotent capabilities/role_grants seed for inbox-triage. Assign at next dispatch once TASK-001 and TASK-002 are merged.

**Spec pointers:** WBS OIK-014/016. Synthesis §5.1 (schema). Handover §4.4 (Gmail manifest shape — seed tiers must match: email.list T0_observe, email.create_draft T1_draft, email.send T3_external disabled; inbox-triage max_tier T1_draft, rate 40/h).

**Intended approach:** pg (node-postgres) with a typed function per access path, pool limits in config; no raw SQL escapes the package. Seed as an idempotent upsert script. Integration tests against the compose database.

## Work Log
