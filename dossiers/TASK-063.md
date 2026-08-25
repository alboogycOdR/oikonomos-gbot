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
