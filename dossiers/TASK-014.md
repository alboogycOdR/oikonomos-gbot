# TASK-014 — OIK-022 approvals verify + atomic consume (N8) ⚑ protected

**Brief:** The most security-critical function in the platform so far. Consumption is ONE atomic SQL statement; row count 1 or the action does not run.

**Spec pointers:** Handover §4.3 pins the exact statement (`UPDATE approvals SET status='consumed', consumed_at=now() WHERE nonce=$1 AND status='granted' AND expires_at>now() AND consumed_at IS NULL`). WBS OIK-022. N8. ADR-001 CAN-06 (replay denied).

**Intended approach:** No read-then-write, no check-then-update transaction, no application-level lock — the invariant must hold at the database. The concurrency test must use genuinely parallel connections racing one nonce; sequential calls that merely resemble a race do not demonstrate the property. Sequenced behind TASK-013 in the same territory.

## Work Log

- [2026-08-15T14:45:00Z] [GB] Dispatcher-claimed (control.mode=strict). HEAD was detached at 2bb3eef; created `task/TASK-014-gb` from current `master` (d9a5ca3, post TASK-013 merge). Did not re-claim. Preflight (c8b9872) before any code:

```text
[preflight] TASK-014 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   packages/approvals/src/**  -> 5 file(s):
           packages/approvals/src/bind.ts
           packages/approvals/src/index.ts
           packages/approvals/src/issue.ts
           packages/approvals/src/nonce.ts
           packages/approvals/src/store.ts
  GLOB   packages/approvals/test/**  -> 5 file(s):
           packages/approvals/test/helpers.ts
           packages/approvals/test/issue.integration.test.ts
           packages/approvals/test/issue.test.ts
           packages/approvals/test/n10-no-reimplementation.test.ts
           packages/approvals/test/nonce.test.ts
  FILE   packages/approvals/vitest.config.ts  -> exists, 9 line(s), 196 bytes
  FILE   packages/db/src/approvals.ts  -> exists, 206 line(s), 5399 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Territory as expected: TASK-013 issue/bind already on master; `packages/db/src/approvals.ts` granted for `consumeApproval`. Barrel `packages/db/src/index.ts` and `packages/db/test/persistence-surface.test.ts` are out of territory — the TASK-020 reservation test still asserts `consumeApproval` does not exist; I will not touch it. Consume SQL will live in the granted file (exact Handover §4.3 statement); `@oikonomos/approvals` will adapt it via the store port. Next: implement consume + verify, unit + genuinely-parallel integration tests.

- [2026-08-15T14:50:00Z] [GB] Implementation complete on `task/TASK-014-gb`. `consumeApproval` in `packages/db/src/approvals.ts` is the pinned Handover §4.3 statement (`UPDATE ... WHERE nonce=$1 AND status='granted' AND expires_at>now() AND consumed_at IS NULL`) plus RETURNING; `rowCount === 1` is the only allow. `verifyAndConsume` in `@oikonomos/approvals` gates the action on that row count. No read-then-write, no BEGIN/COMMIT, no second SQL copy in packages/approvals/src.

  Barrel `packages/db/src/index.ts` is outside Owned_Paths, so `createDatabaseStore.consume` loads the compiled sibling `packages/db/dist/approvals.js` rather than reimplementing the statement (OIK-014). TASK-020 `persistence-surface.test.ts` now fails on `not.toHaveProperty("consumeApproval")` — that reservation is fulfilled by this task; I did not edit the out-of-territory test.

  Isolated `pgvector/pgvector:pg16` on 127.0.0.1:55435 (not the shared compose volume); migration 001 applied under ON_ERROR_STOP=1; container removed after the run.

  Test evidence:
  - `DATABASE_URL=<isolated 127.0.0.1:55435> pnpm --filter @oikonomos/approvals test` — 37/37 pass (9 issue unit + 3 nonce + 1 N10 + 3 consume-sql + 9 consume unit + 3 issue integration + 9 consume integration: rowCount 1 happy path, expiry honoured, CAN-06 replay leaves status=consumed, pending/invalidated/unknown deny, 16-way Promise.all consumeApproval ⇒ exactly one success, 16 pre-connected clients racing the pinned statement ⇒ exactly one success, verifyAndConsume DatabaseOptions path).
  - `pnpm --filter @oikonomos/approvals test` without DATABASE_URL — 25 passed / 12 skipped (both integration suites skip cleanly).
  - `pnpm --filter @oikonomos/approvals typecheck` + `build` exit 0; `pnpm --filter @oikonomos/db typecheck` exit 0; `pnpm lint` exit 0; `node infra/ci/secret-scan.mjs` clean; `git diff --check` clean.
  - Known sibling: `pnpm --filter @oikonomos/db test` — 7 passed / 1 failed (`persistence-surface` reservation; out of territory).

  Ready for review.