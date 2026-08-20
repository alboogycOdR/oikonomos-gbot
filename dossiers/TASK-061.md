# TASK-061 - packages/db read + CRUD layer for control-api

## Brief
Add the db functions TASK-056 needs and does not have. **This task exists because ORCH's TASK-056 decompose was wrong** — it specified six endpoints, five of which had no backing API. S5 caught it and blocked rather than writing raw SQL in a service or reaching into a protected package.

## Spec pointers
- OIK-014 — typed query layer; **no raw SQL outside `packages/db`**. That rule is why control-api could not simply write its own queries.
- Synthesis Spec §5.1 — the `tasks` table **already exists** in `infra/postgres/migrations/001_schema_v1.up.sql`. Read it, match the live columns; no migration, no schema change.
- OIK-013 — `audit_events` is append-only. The new read path is read-only by construction.

## Intended approach
Follow `runs.ts` conventions exactly (typed, parameterised, no `any`):
- new `tasks.ts`: `createTask` / `getTask` / `listTasks`
- `runs.ts`: `listRuns(filter)` — paginated, deterministic order
- `approvals.ts`: `listPendingApprovals()` — pending and unexpired only
- `auditEvents.ts`: `getAuditEventsForRun(runId)`

Barrel edits append-only. **Do not touch `packages/approvals`** — protected, and TASK-062's territory. DB-gated tests must actually RUN green locally (a skipping DB test is not evidence — TASK-035/044).

Known oddity, do not try to fix here: approval SQL already lives in two places (`packages/db/src/approvals.ts` and `packages/approvals/src/store.ts`). Pre-existing.

## Work Log
