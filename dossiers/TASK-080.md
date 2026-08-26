# TASK-080 — atomic editApproval (pending-invalidate + reissue in one transaction)

## Brief

Add `editApproval(nonce, editedRequest)` in `packages/approvals`: one `pool.connect()` client,
`BEGIN` → TASK-064 pending-guarded invalidate (rowCount 1 or ROLLBACK and refuse) → INSERT of a
replacement bound to the EDITED payload (new CSPRNG nonce, digest + ADR-004 render) → `COMMIT`.
Any error rolls back; the client is always released. Hazard: never two live nonces, never
invalidated-with-no-replacement.

## Work Log

- [2026-08-26T15:53:31Z] [GB] Session start (control.mode=strict — no PLAN.md writes). Read
  AGENTS.md, briefings/GROK_BUILD_BRIEFING.md, PLAN.md TASK-080 (claimed, Assigned_To GB, branch
  task/TASK-080-gb, Started_At 2026-08-26T15:48:41Z). No prior dossier. Worktree was on
  task/TASK-054-gb; created task/TASK-080-gb from master `49e643b` (dispatcher claim). Did not
  re-claim. Preflight:

  ```
  [preflight] TASK-080 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    packages/approvals/src/editApproval.ts  -> does not exist; parent packages/approvals/src/ exists
    NEW    packages/approvals/src/editApproval.test.ts  -> does not exist; parent packages/approvals/src/ exists
    FILE   packages/approvals/src/store.ts  -> exists, 275 line(s), 9320 bytes
    FILE   packages/approvals/src/index.ts  -> exists, 45 line(s), 1221 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

  Constraint noted before writing: `packages/approvals/src/decide.test.ts` (outside Owned_Paths)
  pins that `store.ts` contains no `BEGIN`/`COMMIT`/`SELECT`. Transaction must live in
  `editApproval.ts`; `store.ts` only gains an additive `withApprovalClient` (connect/release,
  no transaction keywords) so existing GRANT/REJECT operations and that pin stay intact.

- [2026-08-26T16:02:29Z] [GB] Implementation complete on task/TASK-080-gb. `editApproval` runs
  TASK-064's `INVALIDATE_PENDING_APPROVAL_SQL` then `INSERT_APPROVAL_SQL` on one
  `withApprovalClient` session inside BEGIN/COMMIT; rowCount 0 rolls back and refuses; any
  throw rolls back; `client.release()` + `pool.end()` in finally. Replacement nonce is
  `generateNonce()`; digest + render both derived from the edited payload (ADR-004).
  `withPool` and existing store operations unchanged. Existing `packages/approvals/test/**`
  diff empty. INVALIDATE_APPROVAL_SQL and INVALIDATE_PENDING_APPROVAL_SQL not in the store.ts
  diff.

  Isolated throwaway pgvector/pg16 `oikonomos-task080-pg` on 127.0.0.1:55480 (not the
  unscoped tvcp-pg16:55433), schema `001_schema_v1.up.sql` applied.

  Test evidence:
  - DATABASE_URL=postgresql://oikonomos:local_test_only@127.0.0.1:55480/oikonomos
    pnpm --filter @oikonomos/approvals test → 16 files, **106/106 passed, 0 skipped**
    (editApproval 14/14 including live forced-failure rollback, two-pool mutation contrast,
    decide+consume refuse of the old nonce, per-status zero-write refusals, 8-way concurrent
    edit, ADR-004 digest/render from the edited payload).
  - DATABASE_URL unset: **77 passed / 29 skipped** (editApproval 7 skipped — DB-gated legs
    skip cleanly; 7 source-pin tests still run).
  - MUTATION-PROVEN: removed `await client.query("BEGIN")` so the invalidate autocommitted;
    forced-failure test went RED (`status: 'invalidated'` vs expected `'pending'`). Restored
    BEGIN; suite green again. The two-pool test independently leaves the original invalidated
    after the same injected fault.
  - pnpm lint exit 0.
  - pnpm canaries (DATABASE_URL set) 11 files, **17/17 passed**.
  - pnpm --filter @oikonomos/approvals build; pnpm -r test (DATABASE_URL unset) **exit 0**.
  - git diff -- packages/approvals/test empty.

  Throwaway container `oikonomos-task080-pg` removed after evidence. Ready for review.

- [2026-08-26T20:45:00Z] [GB] Resume (control.mode=strict — no PLAN.md writes). Dispatcher
  re-launched on existing `task/TASK-080-gb` @ 4e5b3a4 after ORCH rework. Did not re-claim
  or re-branch. Review_Findings (round 1): replacement took run_id/capability_id/tenant_id
  from editedRequest with no compare against the voided row (tier-laundering shape);
  fold-in F2 (testHooks is production-visible via structural typing) and F6 (pending but
  expires_at already past, sweeper not run). Stopping point: implement identity bind +
  tests, then live pg16 evidence.

- [2026-08-26T21:28:00Z] [GB] Round-1 rework complete on task/TASK-080-gb. After the
  pending-guarded invalidate, `assertIdentityBound` compares run_id/capability_id/tenant_id
  against the voided row and throws (ROLLBACK) on any divergence; INSERT binds those three
  columns from the invalidated row, not the caller. Omitted tenantId is treated as
  `basileia` (same COALESCE the insert uses). Test hooks are keyed on unique symbol
  `EDIT_APPROVAL_TEST_HOOKS` (not on the barrel; `{ afterInvalidate }` is inert). F6:
  still-pending + expires_at already past, sweeper not run, is refused with zero writes
  and status stays pending.

  Isolated throwaway pgvector/pg16 `oikonomos-task080-pg` on 127.0.0.1:55480; schema
  `001_schema_v1.up.sql` applied; container removed after evidence.

  Test evidence:
  - DATABASE_URL set: pnpm --filter @oikonomos/approvals test → 16 files, **113/113
    passed, 0 skipped** (editApproval 21/21 live, incl. per-field identity refuse +
    rollback, omitted-tenant defaulting to basileia, structural afterInvalidate ignored,
    pending-but-past-expires_at zero writes).
  - DATABASE_URL unset: **79 passed / 34 skipped** (editApproval 9 source-pin tests run;
    12 DB legs skip cleanly).
  - MUTATION-PROVEN (identity): commenting out `assertIdentityBound` turned the
    capability_id test RED (`promise resolved { edited: true }` vs expected throw
    `cannot rebind capability_id`). Restored; suite green.
  - Prior MUTATION-PROVEN (BEGIN / two independent pools) still in the suite and green.
  - pnpm lint exit 0.
  - pnpm canaries (DATABASE_URL set) 11 files, **17/17 passed**.
  - pnpm --filter @oikonomos/approvals build exit 0.
  - pnpm -r test (DATABASE_URL unset) **exit 0**.
  - git diff -- packages/approvals/test empty. store.ts / index.ts unchanged this round.

  Ready for review.
