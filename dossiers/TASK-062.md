# TASK-062 - packages/approvals decision transitions (PROTECTED)

## Brief
`packages/approvals` can issue an approval and can `verifyAndConsume` an already-granted one — but has **no way to move `pending` to `granted` or `rejected`**. The human decision step has no API. That is the other half of the gap S5 found in TASK-056.

## Spec pointers
- N8 / OIK-022 — approvals are nonce-bound and single-use; consumption is **one atomic SQL statement**. Each new transition must follow the same shape as `CONSUME_APPROVAL_SQL`: status-guarded, row count 1 or it did not happen.
- OIK-023 — expired/invalidated rows must never become granted.
- OIK-086 — Approve/Reject is the surface's decision step; this is the API behind it.

## Intended approach
`decide.ts` with `grantApproval` / `rejectApproval` (or one `decideApproval`), SQL in `store.ts` alongside the existing statements.

**The separation that matters:** granting must NOT consume. Approve and use are two steps — a granted approval still has to go through `verifyAndConsume` to be spent. A test must prove it.

Additive only: existing consume/issue paths unchanged, existing tests byte-identical. Mutation to run: remove the status guard from the transition SQL and a test must go red.

**Protected path:** GB or CX only, never S5 (different-model review).

## Work Log

- [2026-08-22T05:54:00Z] [GB] Dispatcher-claimed (control.mode=strict). HEAD was detached at 3df4f96; created `task/TASK-062-gb`. Did not re-claim. Preflight (c8b9872) before any code:

```text
[preflight] TASK-062 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    packages/approvals/src/decide.ts  -> does not exist; parent packages/approvals/src/ exists
  NEW    packages/approvals/src/decide.test.ts  -> does not exist; parent packages/approvals/src/ exists
  FILE   packages/approvals/src/store.ts  -> exists, 180 line(s), 5645 bytes
  FILE   packages/approvals/src/index.ts  -> exists, 29 line(s), 811 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Constraint that shaped the design: `ApprovalStore.grant`/`reject` are optional so existing fakes in `test/helpers.ts`, `test/consume.test.ts`, `test/issue.test.ts`, and `evals/harness/test/helpers.ts` stay type-valid (those files are outside Owned_Paths). SQL lives only in `store.ts` because `test/invalidate-sql.test.ts` forbids `UPDATE approvals SET status=` in every other `src/*.ts` file. Tests live in `src/decide.test.ts` (Owned_Paths) behind `import.meta.vitest` so they run via the existing `includeSource: src/**/*.ts` without touching `vitest.config.ts`. Next: implement SQL + API + tests.

- [2026-08-22T06:04:21Z] [GB] Implementation complete on `task/TASK-062-gb`.

  Public API: `grantApproval` / `rejectApproval` / `decideApproval(nonce, decision, decidedBy, deps)`. Each transition is one pinned UPDATE in `store.ts`:

  - `GRANT_APPROVAL_SQL`: `UPDATE approvals SET status='granted', decided_by=$2, decided_at=now() WHERE nonce=$1 AND status='pending' AND expires_at>now() AND consumed_at IS NULL`
  - `REJECT_APPROVAL_SQL`: same guards, `status='rejected'`

  Neither statement sets `consumed_at`. `createDatabaseStore` wires `grant`/`reject`. `packages/db` is untouched (its N8 source guard still allows exactly one UPDATE there — consume).

  Isolated `pgvector/pgvector:pg16` on `127.0.0.1:55462` (container `oikonomos-task062-pg`, not the shared compose volume); `001_schema_v1.up.sql` applied; container removed after the run.

  MUTATION (drop `AND status='pending'` from GRANT_APPROVAL_SQL only, live DB):
  - pin test RED (`toContain("AND status='pending'")`)
  - Postgres parallel grant: expected 1 success, received 16
  - Postgres invalidated-then-grant: row became granted again (OIK-023)
  Restored; 82/82 green.

  Existing `packages/approvals/test/**` unmodified (git diff empty). Ready for review.
