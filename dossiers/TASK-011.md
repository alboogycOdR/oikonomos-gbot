# TASK-011 — OIK-025 packages/audit append-only writer

**Brief:** The audit writer over the `audit_events` table. Every decision is written including denials, and a write failure must fail the action closed rather than being swallowed.

**Spec pointers:** WBS OIK-025. Synthesis §5.1 for the `audit_events` shape. ADR-001 R3 (fail closed). TASK-002 already enforces append-only in the database via `DO INSTEAD NOTHING` rules — verify the property from the writer's side rather than re-testing the SQL.

**Intended approach:** Typed writer over `@oikonomos/db`. Surface write failures to the caller explicitly. Integration tests against the compose Postgres following TASK-006's precedent of skipping cleanly when `DATABASE_URL` is unset. N4 is sharp here: audit payloads are exactly where a careless fixture leaks a credential.

## Work Log