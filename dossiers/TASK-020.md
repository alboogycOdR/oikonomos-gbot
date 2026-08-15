# TASK-020 — packages/db persistence surface for audit_events + approvals

**Brief:** Single-owner integration task. Deliver `insertAuditEvent`, `insertApproval`, and `getApprovalByNonce` in `packages/db`, plus barrel exports. Do not write `consumeApproval` (reserved for TASK-014).

**Spec pointers:** Synthesis §5.1; WBS OIK-014 / OIK-021 / OIK-025; migration `infra/postgres/migrations/001_schema_v1.up.sql` is the authoritative column set. Handover §4.3 field set for approvals (digest, render, destination, nonce, expiry).

## Work Log

- [2026-08-15T12:50:00Z] [GB] Dispatcher-claimed resume: no prior dossier, no `task/TASK-020-gb` ref. Created branch from detached master@40ef616. Preflight (c8b9872) before any code:

```text
[preflight] TASK-020 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    packages/db/src/auditEvents.ts  -> does not exist; parent packages/db/src/ exists
  NEW    packages/db/src/approvals.ts  -> does not exist; parent packages/db/src/ exists
  FILE   packages/db/src/index.ts  -> exists, 11 line(s), 300 bytes
  GLOB   packages/db/test/**  -> 1 file(s):
           packages/db/test/inbox-triage.integration.test.ts
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Territory is as expected: two NEW modules + existing barrel + existing test glob. `database.ts` is out of territory; functions will take `DatabaseOptions` (already exported) and open a short-lived pool so TASK-011/013 can call them without a generic `query` on `Database`. Next: implement the two modules against migration 001, then tests.

- [2026-08-15T13:05:00Z] [GB] Implemented `insertAuditEvent`, `insertApproval`, `getApprovalByNonce` against migration 001 columns. No `consumeApproval`. Functions take `DatabaseOptions` then the row payload (connection handle omitted from the PLAN shorthand the same way `upsertCapability` omits `this`). Write errors propagate. Integration tests against an isolated `pgvector/pgvector:pg16` container on 127.0.0.1:55432 (not the shared compose volume). Applied `001_schema_v1.up.sql` only; no DROP/TRUNCATE/DELETE.

  Test evidence:
  - `DATABASE_URL=<isolated> pnpm --filter @oikonomos/db test` — 8/8 pass (audit persist+RETURNING match, induced uuid write failure rejects, approval round-trip digest/render/destination/nonce/expiry, unknown nonce → null, inbox-triage seed still 2/2, surface unit tests).
  - `pnpm --filter @oikonomos/db test` without DATABASE_URL — 2 passed / 6 skipped (integration suites skip cleanly).
  - `pnpm lint`, `pnpm -r typecheck`, `pnpm -r build` exit 0; `git diff --check` clean.

  Ready for review.
