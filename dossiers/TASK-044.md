# TASK-044 — OIK-048 MCP registration pipeline (manifest → DB rows)

## Brief
`registerConnector` / `deregisterConnector` in `@oikonomos/connectors`, backed by new `packages/db/src/capabilities.ts` functions (raw SQL stays in packages/db). One transaction, idempotent, reversible, and it refuses unvalidated manifests before any write.

## Spec pointers
- WBS OIK-048: "Manifest → capabilities rows → role_grants, idempotent and reversible".
- Handover §4.4 (manifest fields → row mapping) and §4.2 (tier semantics).
- Live schema is FIXED: no migrations, no enum changes. Schema gap ⇒ block SPEC_AMBIGUITY.
- `packages/db/src/seedInboxTriage.ts` — follow its SQL conventions; the canaries seed via it, so keep row shapes compatible.

## Intended approach
- `src/registration/` with ports for the db functions (testable without pg) + DATABASE_URL-gated integration tests that RUN green locally (a skipping DB test is not evidence — TASK-035 history; ORCH re-runs live at review).
- Idempotency proof: full row-snapshot diff after double-run, not row counts.
- Reversibility proof: two connectors registered; deregister one; other's rows byte-identical.
- Fail closed: registration calls TASK-043's validator first; test asserts zero rows written on invalid input. Mutation: drop the validator call → test red.
- Barrel edits append-only (packages/connectors + packages/db index.ts).

## Work Log
