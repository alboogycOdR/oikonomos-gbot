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

- [2026-08-18T15:40:00Z] [CX] Resumed TASK-044 on `task/TASK-044-cx`. Preflight output: `[preflight] TASK-044 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos`; `GLOB packages/connectors/src/** -> 6 file(s)`; `GLOB packages/connectors/test/** -> 5 file(s)`; `NEW packages/db/src/capabilities.ts`; `NEW packages/db/src/capabilities.test.ts`; `FILE packages/db/src/index.ts -> exists, 40 line(s), 850 bytes`. Read live Handover §4.2/§4.4, WBS OIK-048, ADR-008, manifest validator, and db schema/query conventions. Implementing a db-owned transactional registration port plus connector orchestration and unit/integration tests.
- [2026-08-18T15:45:00Z] [CX] Implementation complete and committed locally: db-owned `createConnectorRegistrationStore` wraps registration/deregistration in one transaction; connector orchestration validates raw YAML before invoking the store, expands each role grant across manifest tools, and preserves per-tool disabled state. `pnpm --filter @oikonomos/db build`, `pnpm --filter @oikonomos/connectors typecheck`, connector tests (26/26), `pnpm -r test`, `pnpm lint`, and `pnpm canaries` all exit 0. Mutation proof: changing the validator guard to `if (false && !validation.ok)` makes the non-Basileia test fail; restored guard immediately. BLOCKED only on the required live DB leg: `DATABASE_URL` is unset; two pre-existing pg16 containers are running, but the team protocol prohibits destructive database/container actions (the reversal test calls deregistration) without explicit authority. Next: provide an approved disposable local pg16 `DATABASE_URL`, run `pnpm --filter @oikonomos/db test` with it (TASK-044 2 integration tests must run rather than skip), then hand off for review.
