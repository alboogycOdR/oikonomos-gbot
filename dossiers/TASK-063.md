# TASK-063 - control-api atomic invalidate-and-reissue (Edit lifecycle)

## Brief
Add the one control-api operation TASK-058's Edit button needs and cannot have: invalidate an approval and issue a replacement bound to the edited payload. **This task exists because ORCH's decompose was wrong** — TASK-056 shipped six endpoints, none of which can edit an approval, while TASK-058's AC requires exactly that. CX blocked before writing code rather than build the lifecycle in the gateway. Right call.

## The primitives already exist — reuse them
`packages/approvals` exports:
- `ApprovalStore.invalidate(nonce)` — OIK-023's pinned, status-guarded SQL
- `issueApproval` — issues with nonce, digest, render, expiry

They were simply never surfaced through control-api. **Do not reimplement either**, and do not touch `packages/approvals` (protected) — consume its public API. Missing primitive ⇒ BLOCK SPEC_AMBIGUITY.

## The hazard to design against
A non-transactional implementation can leave the old row `pending` while the replacement is already issued — **two live nonces for one action, i.e. a double-approval path**. Equally bad in the other direction: invalidated with no replacement. Both legs go in one transaction; a forced mid-operation failure must leave the original untouched.

## ADR-004 is binding
The replacement's stored render must be regenerated from the **edited** payload, and its digest must bind that **same** edited payload. A render describing the old payload while the digest binds the new one is exactly the approve-one-thing-execute-another failure ADR-004 exists to prevent.

## Spec pointers
- OIK-086 — "edit invalidates prior approval and re-enters cycle"
- OIK-023 — invalidation on payload mutation
- OIK-084 — publish the route in the OpenAPI document; the Telegram lane codes against it
- N8 — nonce-bound, single-use

## Work Log

- [2026-08-25T05:55:00Z] [S5] Session start (control.mode=strict — no PLAN.md writes; dossier +
  devteam-control block instead). Read AGENTS.md, briefing, PLAN.md TASK-063 block (Status:
  claimed, Owned_Paths: services/control-api/src/**, services/control-api/test/**).
  `.devteam/CHECKPOINT.md` was stale (referenced the already-merged TASK-056) — ignored per "files
  are the truth"; left in place since deleting it isn't in my Owned_Paths.
  Created branch `task/TASK-063-s5` off the then-worktree-HEAD (`ef3914b`, the TASK-056 merge
  commit). Firewall initially blocked writing this dossier because the worktree's own PLAN.md copy
  was stale (pre-dated the TASK-063 claim, so `activeTaskIdFor` still resolved to TASK-056) — fixed
  by fast-forward-merging the local `master` branch (same repo, shared `.git`, no network needed)
  into my task branch: `git fetch . master:refs/heads/_main_sync && git merge _main_sync` (FF-only,
  brought in PLAN.md + other already-committed main content, no new authorship), then deleted the
  temp ref. Confirmed PLAN.md now shows TASK-063 Status: claimed and the dossier write succeeded.
  Ran `python scripts/preflight_paths.py TASK-063 --repo <main-checkout>` (paste below).

  ```
  [preflight] TASK-063 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/oikonomos
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   services/control-api/src/**  -> 5 file(s):
             services/control-api/src/app.ts
             services/control-api/src/index.ts
             services/control-api/src/openapi.ts
             services/control-api/src/ports.ts
             services/control-api/src/redact.ts
    GLOB   services/control-api/test/**  -> 4 file(s):
             services/control-api/test/app.test.ts
             services/control-api/test/decide.route.test.ts
             services/control-api/test/integration.test.ts
             services/control-api/test/no-raw-sql.test.ts
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-08-25T06:10:00Z] [S5] Investigated the "REUSE, don't reimplement" primitive this task
  names: `packages/approvals`'s `ApprovalStore.invalidate(nonce)`. Read
  `packages/approvals/src/store.ts` and its tests directly (protected package, read-only):
  - `INVALIDATE_APPROVAL_SQL` (pinned, `packages/approvals/src/store.ts:39-40`):
    `UPDATE approvals SET status='invalidated' WHERE nonce=$1 AND status='granted' AND consumed_at IS NULL`
  - `packages/approvals/test/invalidate-sql.test.ts:12` pins that exact statement text under the
    name "invalidates only granted unused rows for one nonce".
  - `packages/approvals/test/invalidate.test.ts:73` — "does not invalidate a still-pending approval
    on mismatch" — explicitly asserts `invalidate()` is a no-op (`rowCount: 0`) against a `pending`
    row.
  - This is OIK-023's actual mechanism: digest-mismatch invalidation of an already-**granted**
    approval, detected at consume-time inside `verifyAndConsume`
    (`packages/approvals/src/consume.ts`), not a general-purpose invalidate.

  **This contradicts this task's own AC #7**: "Editing a non-pending approval (already decided,
  expired, invalidated, consumed) is refused per status" — i.e. Edit is valid **only** while
  `status='pending'`, matching WBS OIK-086 ("Approve/Edit/Reject" are the three buttons offered on
  a still-*pending* Telegram approval message, before any decision is made). But the only
  invalidate primitive `packages/approvals` exports is guarded to `status='granted'` and is
  proven-by-test to be a no-op against `pending`. Calling `deps.invalidate(nonce)` from the new
  edit route against the one state Edit is supposed to accept (`pending`) will always return
  `rowCount: 0` — a successful edit of a pending approval is structurally impossible through this
  primitive as it exists today. Checked every other export in
  `packages/approvals/src/index.ts` (`grant`, `reject`, `consume`, `expirePending`, `issueApproval`,
  `sweepExpiredApprovals`) — none transitions a `pending` row to `invalidated`. Also checked
  `packages/db/src/approvals.ts` (unprotected but outside this task's `Owned_Paths` regardless) —
  only exports `insertApproval`, `getApprovalByNonce`, `consumeApproval`, `listPendingApprovals`;
  no pending-guarded invalidate there either.

  This is the exact "producer's contract doesn't have what the consumer's AC needs" shape this task
  itself exists to close (cf. TASK-056's missing db/approvals APIs, and TASK-058's block before
  this task). Per this task's own Description — "Do NOT touch packages/approvals (protected);
  consume its public API only — if a needed primitive is genuinely missing there, BLOCK with
  SPEC_AMBIGUITY rather than reach in" — blocking rather than adding a pending-guarded invalidate
  SQL/method myself inside `packages/approvals` (protected, adversarial-review path, outside
  `Owned_Paths`) or inside `packages/db` (also outside `Owned_Paths`).

  No implementation code written; branch `task/TASK-063-s5` carries no commits beyond the
  fast-forward sync to `master`.

  **Recommendation for ORCH:** the likely fix is a new pinned, status-guarded primitive in
  `packages/approvals` — e.g. `invalidatePending(nonce)` mirroring `GRANT_APPROVAL_SQL`/
  `REJECT_APPROVAL_SQL`'s shape (`UPDATE approvals SET status='invalidated' WHERE nonce=$1 AND
  status='pending' AND expires_at>now() AND consumed_at IS NULL`), exposed through `ApprovalStore`
  and the package barrel — the same pattern TASK-062 used to add `grant`/`reject`. That is
  protected-path work requiring adversarial review by a different model (per CLAUDE.md), and sits
  outside this task's `Owned_Paths` regardless of who implements it, so it can't be done from this
  worktree/task either way.

- [2026-08-26T15:44:00Z] [S5] Session resumed (control.mode=strict). Re-read AGENTS.md, briefing,
  PLAN.md fresh from disk (main checkout, `C:/CLAUDECODE_TOOLSETS/oikonomos/PLAN.md`, commit
  `c643b9e`). `.devteam/CHECKPOINT.md` was stale (referenced the pre-TASK-064 compaction) and not
  in `Owned_Paths` — left in place, ignored per "files are the truth". Confirmed via PLAN.md that
  ORCH validated the prior block as CORRECT (2026-08-25T06:00Z note: "S5 BLOCKED CORRECTLY AND WAS
  RIGHT"), spun off TASK-064 (CX, protected path) to add the missing `invalidatePendingApproval`
  primitive, TASK-064 is `Status: done` / merged (`6c913e9`, adversarial-reviewed by ORCH-opus per
  the different-model rule, first-pass approve, 562/562 suite green), and this task was reopened
  with `Depends_On: TASK-064` now satisfied and `Started_At` bumped to a fresh dispatch
  (`2026-08-26T15:42:58Z`).

  My branch (`task/TASK-063-s5`) predated the TASK-064 merge, so it did not yet have
  `packages/approvals/src/invalidatePending.ts`. Brought master's already-merged content into my
  branch the same way the prior session synced PLAN.md — `git fetch . master:refs/heads/_main_sync
  && git merge _main_sync` (real merge commit this time, not FF, since both branches had diverged
  commits — `_main_sync` had TASK-064 and later PLAN.md updates, mine had only the dossier commit;
  no conflicts, nothing but already-reviewed/merged content pulled in), then deleted the temp ref.
  Re-ran `python scripts/preflight_paths.py TASK-063` implicitly by re-reading the same two
  `Owned_Paths` globs directly — unchanged from the first check (5 files under `src/**`, 4 under
  `test/**`), still current.

  **Read the new primitive at source** (`packages/approvals/src/invalidatePending.ts`,
  `packages/approvals/src/store.ts:49-50,187-207,270`): `invalidatePendingApproval(nonce, deps)`
  now exists, is pending-guarded (`INVALIDATE_PENDING_APPROVAL_SQL`: `WHERE nonce=$1 AND
  status='pending' AND expires_at>now() AND consumed_at IS NULL`), and is exported from the package
  barrel (`packages/approvals/src/index.ts:26-29`). AC #6's "reuse, no reimplementation" blocker
  from before is now closed.

  **Found a second, deeper missing primitive while wiring the actual route: no shared-transaction
  composition exists between `invalidatePendingApproval` and `issueApproval`.** Read both source
  files end to end plus `packages/db/src/database.ts` and `packages/approvals/src/store.ts` in
  full:
  - `store.ts`'s `withPool()` (`store.ts:128-144`) opens a **brand-new `Pool`, runs one query,
    then calls `pool.end()`** — every single store operation (`invalidatePending`, `insert`,
    `consume`, `grant`, `reject`, `expirePending`) gets its own connection lifecycle. There is no
    shared `PoolClient`/transaction context threaded through any of them, and no `BEGIN`/`COMMIT`
    anywhere in `packages/approvals/src/**` — `decide.test.ts:191-196` explicitly pins that
    `store.ts` issues "each transition as one UPDATE with no BEGIN/COMMIT/SELECT".
  - `issueApproval` (`issue.ts:102-136`) calls `store.insert(...)` — again through
    `createDatabaseStore` → `withPool`, its own separate connection.
  - Calling `invalidatePendingApproval(nonce, {database})` followed by `issueApproval(request,
    {database})` from control-api would therefore run as **two independent, non-transactional
    round-trips on two different connections** — exactly the non-atomic implementation this task's
    own Description calls out as the hazard to design against: "a non-transactional implementation
    can leave the old row `pending` while the replacement is already issued... A partial failure
    must leave the old approval untouched, never invalidated-with-no-replacement." AC #2 requires
    this proven with a **forced mid-operation failure**, live DB — that test cannot pass without
    real transactional atomicity; a crash/throw between the two independent calls above would leave
    the old row invalidated with no replacement (or vice-versa depending on ordering), which is
    precisely the forbidden state.
  - Checked whether either package exposes ANY transaction-composition primitive at all:
    `grep -rniE "transaction|BEGIN|COMMIT|ROLLBACK|PoolClient|connect\(\)"` across
    `packages/db/src` and `packages/approvals/src` — the only `BEGIN`/`COMMIT`/`PoolClient` usage
    in the whole codebase is internal and private to `packages/db/src/capabilities.ts`'s
    register/deregister connector functions (`capabilities.ts:45-121`, `pool.connect()` +
    `BEGIN`/`COMMIT`/`ROLLBACK` around multiple statements) — a real precedent for the *pattern* a
    fix would need, but it is not exported, not generic, and not usable from approvals or
    control-api as-is.
  - Also checked `verifyAndConsume` (`consume.ts:54-91`) for a precedent of composing two store ops
    safely without a shared transaction: its digest-mismatch path does `getByNonce` then
    `store.invalidate` as two separate calls too — but that is safe *only* because the actual
    security gate is the single atomic `consume` call afterward ("`consumed: true` is the only
    signal the action may run"); the invalidate-on-mismatch is best-effort cleanup, not something
    an AC requires to be atomic. TASK-063's AC #2 is a strictly stronger requirement (both writes
    must commit-or-none, proven under forced failure) that nothing in this codebase currently
    provides.
  - Grepped `specs/`, `docs/`, `packages/`, `services/` for `editApproval`/`reissue`/
    `invalidateAndReissue`/`atomicEdit` — no hits; no already-named primitive I overlooked.

  **Why this can't be closed from this task's territory:** `Owned_Paths` is
  `services/control-api/src/**` + `test/**` only. The fix is a new atomic primitive spanning both
  writes on one connection/transaction — that has to live in `packages/approvals` (protected,
  different-model adversarial review, same as TASK-064) since it needs to call both the pending
  invalidate SQL and the insert SQL inside one `BEGIN...COMMIT`. Building the transaction in
  control-api instead is not an option: it would require holding a `pg` `Pool`/`Client` or
  composing raw SQL there, which `test/no-raw-sql.test.ts` mechanically forbids and which directly
  violates OIK-084 ("not the DB") and this task's own instruction to consume approvals' public API
  only, never reach in. Per that same instruction — "if a needed primitive is genuinely missing
  there, BLOCK with SPEC_AMBIGUITY rather than reach in" — blocking again, same shape as the first
  round, one layer deeper.

  No implementation code written this session beyond the master-sync merge commit (brings in
  already-reviewed TASK-064 content only, no new authorship). No commits touch anything outside
  `Owned_Paths`/dossier.

  **Recommendation for ORCH:** likely fix is a new `packages/approvals` export — e.g.
  `editApproval(nonce, request, deps)` — that opens one `PoolClient` (mirroring
  `capabilities.ts:45-121`'s `pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK` shape), runs the
  pending-guarded invalidate UPDATE and the new-row INSERT on that same client inside one
  transaction, and returns both the invalidated approval and the new `ApprovalWaitSignal` (or
  `null`/thrown on the invalidate returning 0 rows, rolling back before any insert happens). That
  is protected-path work needing a new TASK (same shape as TASK-064) assigned to GB or CX with
  different-model adversarial review — outside this task's `Owned_Paths` regardless of who
  implements it, so it can't be done from this worktree/task either way.
