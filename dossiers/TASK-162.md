# TASK-162 Dossier

## Work Log

- [2026-09-06T15:18:00Z] [CX] Preflight: `services/control-api/src/chat.routes.test.ts` (1561 lines) and `packages/db/src/runs.test.ts` (463 lines) exist. PATCH-instructions, approval-resume, and `runs.test.ts -t listOpenRuns` pass independently; `runs.test.ts` full passes 13/13.
- [2026-09-06T15:18:00Z] [CX] Root-cause evidence: `chat.routes.test.ts` fails in isolation with `sorry, too many clients already`; the group fixture alone reproduces it twice. Its normal `GET /threads` path returns that error, proving this is not an assertion/order defect. Immediately after failure, a read-only pg query reported 6 `pg_stat_activity` connections with Postgres `max_connections=100`, pointing to the shared pooler/client layer. Test-only one-client-pool and lifecycle synchronization attempts did not resolve it; they remain uncommitted.
