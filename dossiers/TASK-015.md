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