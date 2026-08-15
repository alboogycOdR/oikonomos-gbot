# TASK-015 — OIK-023 + OIK-024 approvals invalidation + expiry sweeper ⚑ protected

**Brief:** Payload mutation after grant invalidates the approval; expired pending approvals are swept idempotently.

**Spec pointers:** WBS OIK-023, OIK-024. ADR-001 CAN-07 (mutate-after-approval must fail). Two finishers combined because they share territory and neither fills a session alone.

**Intended approach:** Recompute the digest at consume time and compare; mismatch ⇒ `invalidated`, and an invalidated approval must not be consumable even with a valid nonce. The sweeper must be safe run twice and safe run concurrently with itself.

## Work Log

- [2026-08-15T15:16:34Z] [GB] Dispatcher-claimed (control.mode=strict). HEAD was detached at a5b284a; created `task/TASK-015-gb`. Did not re-claim. Preflight (c8b9872) before any code:

```text
[preflight] TASK-015 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   packages/approvals/src/**  -> 6 file(s):
           packages/approvals/src/bind.ts
           packages/approvals/src/consume.ts
           packages/approvals/src/index.ts
           packages/approvals/src/issue.ts
           packages/approvals/src/nonce.ts
           packages/approvals/src/store.ts
  GLOB   packages/approvals/test/**  -> 8 file(s):
           packages/approvals/test/consume-sql.test.ts
           packages/approvals/test/consume.integration.test.ts
           packages/approvals/test/consume.test.ts
           packages/approvals/test/helpers.ts
           packages/approvals/test/issue.integration.test.ts
           packages/approvals/test/issue.test.ts
           packages/approvals/test/n10-no-reimplementation.test.ts
           packages/approvals/test/nonce.test.ts
  FILE   packages/approvals/vitest.config.ts  -> exists, 9 line(s), 196 bytes
  FILE   packages/db/src/index.ts  -> exists, 24 line(s), 564 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Territory as expected: TASK-014 consume/verify already on this commit; barrel `packages/db/src/index.ts` is the narrow grant for `consumeApproval` + result type only. `packages/shared/**` and `packages/db/src/approvals.ts` are out of territory. ADR-004 wants `actionRender` beside `actionDigest` in `@oikonomos/shared`; I will derive the render in `packages/approvals` from `canonicalJson` on the identical `{toolName, input, destination}` object (one canonicalization, N10) rather than write outside Owned_Paths. Invalidate/expire SQL will live in the approvals store (db/approvals.ts not granted; package.json cannot gain `pg`). Next: barrel export, then render + invalidate + sweeper.

- [2026-08-15T15:21:51Z] [GB] Implementation complete on `task/TASK-015-gb`.

  AC1: `packages/db/src/index.ts` now exports `consumeApproval` + `ConsumeApprovalResult` and nothing else new. `createDatabaseStore.consume` imports them from `@oikonomos/db`. Integration tests that called `consumeApproval` now do the same; `CONSUME_APPROVAL_SQL` stays imported from `packages/db/src/approvals.ts` (constant is not on the granted barrel).

  AC2 / ADR-004: `actionRender` is derived in `packages/approvals/src/render.ts` from `canonicalJson({toolName, input, destination})` — the identical object `actionDigest` hashes. `IssueApprovalRequest.actionRender` is gone. A sneaked `actionRender` property is ignored. Discriminating test: changing toolName, input, or destination changes the render. Function lives here, not in `packages/shared`, because that package is outside Owned_Paths; canonicalization is still the single shared implementation (N10).

  AC3/AC4 (OIK-023 / CAN-07): `verifyAndConsume(nonce, deps, action?)` recomputes the digest when `action` is supplied; mismatch on a granted row runs `UPDATE approvals SET status='invalidated' WHERE nonce=$1 AND status='granted' AND consumed_at IS NULL`. A later consume with the original payload still fails. `action` is optional so TASK-014 call sites stay valid; the execute path must pass the payload.

  AC5 (OIK-024): `sweepExpiredApprovals` runs `UPDATE approvals SET status='expired' WHERE status='pending' AND expires_at<=now()`. Second run returns 0. Eight concurrent sweepers against 12 expired rows transition each row exactly once (sum of counts = 12). Granted-but-expired rows are left alone.

  Isolated `pgvector/pgvector:pg16` on 127.0.0.1:55436 (not the shared compose volume); migration 001 applied under ON_ERROR_STOP=1; container removed after the run.

  Test evidence:
  - `DATABASE_URL=<isolated 127.0.0.1:55436> pnpm --filter @oikonomos/approvals test` — 55/55 pass (TASK-013/014 suites still green: 9 issue unit + 3 nonce + 1 N10 + 4 consume-sql + 9 consume unit + 3 issue integration + 9 consume integration; plus 4 render, 4 invalidate unit, 4 sweep unit, 3 invalidate-sql, 1 invalidate integration CAN-07, 1 sweep integration concurrent+idempotent).
  - `pnpm --filter @oikonomos/approvals test` without DATABASE_URL — 41 passed / 14 skipped (all four integration files skip cleanly).
  - `pnpm --filter @oikonomos/approvals typecheck` + `build` exit 0; `pnpm lint` exit 0; `node infra/ci/secret-scan.mjs` clean; `git diff --check` clean.

  Ready for review.

- [2026-08-15T16:25:00Z] [GB] Resume on `task/TASK-015-gb` at 4fc3c9a for ORCH rework (opus-4-8, 16:20Z). Two blocking findings, both in-territory: (1) `sweep.integration.test.ts` flaked 1/4 (`expected 13 to be 12`) because unscoped `EXPIRE_PENDING_SQL` collected a foreign pending-expired fixture from a parallel file — scope the sweep/assertion to the fixture `runId` and drop the vacuous `expired >= 0` assert. (2) `consume-sql.test.ts` and `consume.integration.test.ts` still import `../../db/src/approvals.js`; switch those to `@oikonomos/db` so the pin reads the executed export (requires barreling `CONSUME_APPROVAL_SQL`). Also delete unused `ConsumeApprovalFn`. Not touching the pg `createRequire` path (ORCH: not our defect).

- [2026-08-15T16:30:41Z] [GB] Rework complete on `task/TASK-015-gb`.

  BLOCKING 1: `sweepExpiredApprovals` accepts optional `{ runId }` and appends `AND run_id=$1` to the pinned unscoped `EXPIRE_PENDING_SQL`. Production (no scope) still expires every pending-elapsed row. Integration sweep passes the fixture runId; vacuous `expired >= 0` assert removed. Unit test proves a foreign-run pending row is left pending.

  BLOCKING 2: `CONSUME_APPROVAL_SQL` exported from `packages/db/src/index.ts` (needed so the pin can import the executed barrel). `consume-sql.test.ts` and `consume.integration.test.ts` import it from `@oikonomos/db`. Function-body pin uses `consumeApproval.toString()` (the running export). A new test forbids any `packages/approvals/test/**` file from mentioning `db/src/approvals`.

  NON-BLOCKING: deleted `ConsumeApprovalFn` from store.ts and the barrel.

  Test evidence:
  - Isolated `pgvector/pgvector:pg16` on 127.0.0.1:55437 (not shared compose); migration 001 under ON_ERROR_STOP=1; container removed after.
  - `DATABASE_URL=<isolated 127.0.0.1:55437> pnpm --filter @oikonomos/approvals test` × 4 consecutive runs — 57/57 each (EXIT_CODES=0,0,0,0). Was 55; added scoped-sweep unit + executed-export pin.
  - Without DATABASE_URL: 43 passed / 14 skipped.
  - typecheck + build + lint + secret-scan + git diff --check clean.

  Ready for re-review.