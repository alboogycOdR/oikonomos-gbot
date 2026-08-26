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

- [2026-08-26T22:15:00Z] [S5] Session resumed (control.mode=strict). Re-read AGENTS.md, briefing,
  PLAN.md fresh from disk. TASK-080 (`editApproval(nonce, editedRequest, deps)` — one
  `pool.connect()` client, `BEGIN`→pending-guarded invalidate→identity-bound INSERT→`COMMIT`,
  identity-bind fix from round-2 review) is `Status: done`, merged into `master`
  (`d60bd7b`/`d5b83d5`/`039d5e8`), and this task's `Depends_On: TASK-080` is satisfied — ORCH's
  2026-08-26T21:00Z note explicitly unblocks and hands back my own dossier's `next_step`
  recommendation verbatim as the resume plan.

  Found the worktree already carrying uncommitted implementation work against master's merged
  `editApproval` — `services/control-api/src/{app,ports,openapi,redact}.ts`,
  `test/app.test.ts`, and a new `test/edit.route.integration.test.ts`, all still unstaged, no prior
  dossier entry for it (a session that built this apparently ended before logging/committing).
  Read every changed file in full against this task's ACs and TASK-080's actual exported signature
  (`editApproval.ts` read at source) rather than trusting the diff was correct:
  - `ports.ts`: adds `editApproval(nonce, editedRequest)` to `ControlApiDeps`, wired in
    `createDatabaseBackedDeps` straight to `approvalsEditApproval(nonce, editedRequest, {
    database: options })` — no local logic, matches OIK-084 "not the DB" / no-reimplementation.
  - `app.ts`: `POST /approvals/:nonce/edit`, JSON-schema body with `additionalProperties: false`
    and no `render` field (ADR-004 — render is always derived downstream, never caller-supplied),
    tenant_id forwarded through explicitly even when `undefined` (per TASK-080 round-2's carried-
    forward AC — omitted tenantId is a hard refusal for non-basileia tenants, must never be
    dropped), 200 on `edited:true` returning both the invalidated approval and the replacement wait
    signal, 409 on `edited:false`, 400 on thrown error — same try/catch shape as the existing
    decide route, nothing bespoke.
  - `openapi.ts`: `/approvals/{nonce}/edit` path + `EditApprovalRequest`/`EditApprovalResponse`
    schemas added (OIK-084); `app.test.ts`'s existing "every registered route appears in the OpenAPI
    doc" assertion covers it structurally.
  - `redact.ts`: nonce-redaction regex widened from decide-only to `decide|edit` — the same N4
    hazard (bearer nonce in the URL) applies to the new route; a dedicated real-pino-stream test
    proves the nonce never appears in log output for this route.
  - `test/app.test.ts`: fake-backed route tests — 200/409/400 shapes, schema rejects a body missing
    required fields *before* reaching the port (`deps.calls` empty), a caller-supplied `render`
    field is stripped by the schema and never reaches the port, `tenantId` forwarded verbatim
    (present, absent-as-undefined, and non-default value), `expiresAt` string converted to `Date`,
    and the N4 redaction test using a real pino stream.
  - `test/edit.route.integration.test.ts` (new, DB-gated via `describe.skip` when `DATABASE_URL` is
    unset — TASK-035/044/061/064/080 evidence precedent): exercises the route through
    `createDatabaseBackedDeps` against real Postgres — success path with ADR-004 digest/render
    verified by reading the persisted replacement row back (not inferred from the response alone),
    old-nonce-refused-by-both-decide-and-consume, exactly-one-pending-row-by-query, per-status
    refusal for granted/rejected/consumed/invalidated (each status reached via the real
    decide/verifyAndConsume primitives, never a hand-rolled UPDATE), a pending-but-past-expiry
    refusal, a forced-mid-operation-failure leg reached through the public HTTP API (mismatched
    `runId` trips `editApproval`'s own identity-bind check post-invalidate, proving the rollback
    over a live DB from *this* task's territory without needing an internal test hook), and both
    the tenantId-omitted-hard-refusal and tenantId-forwarded-succeeds legs for a non-basileia
    tenant (the round-2 TASK-080 lesson AC).

  Found a running throwaway container `oikonomos-task063-pg` (pgvector/pg16, port 55481, schema
  already migrated — 8 tables incl. `approvals`) left up from whatever session built this, evidently
  for exactly this purpose. Verified it's a private throwaway (not `docker-compose`'s shared
  service, distinct name/port from `tvcp-pg16`) before using it — reused rather than starting a
  second one.

  **Full verification run, this session, fresh:**
  - `pnpm --filter @oikonomos/control-api build` — clean, 0 errors.
  - `pnpm --filter @oikonomos/control-api test` WITH `DATABASE_URL` set: 5 files, 53/53 passed, 0
    skipped (all 11 new edit-route integration tests ran live, not skipped).
  - Same command WITHOUT `DATABASE_URL`: 40 passed / 13 skipped — proves the DB legs are real gated
    tests, not silently-always-skipped ones (TASK-035/044/061 evidence shape).
  - `pnpm -r test` WITH `DATABASE_URL` set: exit 0, all 16 workspaces green — memory 1, policy 21,
    db 51, agent-providers 45, gateway-telegram 54, shared 36, workspace 1, audit 35, connectors 50,
    approvals 113 (incl. `editApproval.test.ts` 21/21 and `invalidatePending.test.ts` 10/10 live),
    harness-factory 79, evals-golden 6, broker 28, control-api 53, worker 13, evals-harness 17 — 603
    tests total, 0 failed. This is the full recursive suite per CLAUDE.md's DEVDEPARTMENT amendment
    (never a filtered per-package run), so a cross-package regression like the 2026-08-15 TASK-014
    incident would have surfaced here.
  - `pnpm lint` — exit 0.
  - `pnpm canaries` — 17/17 (`evals/harness`), exit 0, with `DATABASE_URL` set (CAN-06/CAN-07's
    Postgres-atomicity legs ran live, not skipped).

  No `packages/approvals` files touched (protected, outside `Owned_Paths` either way) — `editApproval`
  consumed exactly as TASK-080 exports it, confirmed by re-reading its source this session rather
  than trusting the pre-existing diff. All AC boxes below verified true against the spec text, not
  the diff's own comments.

  Staged and committing everything under `Owned_Paths`
  (`services/control-api/src/**`, `services/control-api/test/**`) plus this dossier. Nothing outside
  those globs touched; `git status` before commit showed only those files plus the untracked
  `AUTOPILOT_LOG.md` (pack infrastructure, not mine, left alone) and the stale
  `.devteam/CHECKPOINT.md` (not in `Owned_Paths`, left in place per "files are the truth" —
  superseded by this entry; will be deleted once the resume state is genuinely stale, not by me
  mid-task).

  **Status: needs_review.** All stated ACs satisfied and independently re-verified this session;
  full recursive suite green; DB legs proven live both directions (gated vs run). Ready for
  adversarial review — this package (`services/control-api`) is NOT itself protected-path (no
  different-model requirement), but the two upstream primitives it now calls (TASK-064, TASK-080)
  already went through that process.

- [2026-08-26T22:25:00Z] [S5] Session resumed (checkpoint at .devteam/CHECKPOINT.md pointed here;
  re-read AGENTS.md, briefing, PLAN.md fresh from disk per §10). Found all implementation work
  already committed (`b821054`, prior session) — `git status` clean except the untracked
  pack-infra `AUTOPILOT_LOG.md` (not mine) and the now-stale `.devteam/CHECKPOINT.md` (not in
  Owned_Paths, left in place). Confirmed `git diff master...HEAD --stat` touches only
  `dossiers/TASK-063.md` + `services/control-api/{src,test}/**` — no ownership drift. Re-ran
  `pnpm --filter @oikonomos/control-api build` this session: clean, 0 errors, matching the prior
  session's verification. No code changes needed; re-affirming `needs_review` as recorded in the
  prior work-log entry with its full test evidence (603/603 recursive suite, lint clean, canaries
  17/17, all DB legs proven live under DATABASE_URL).

- [2026-08-26T22:32:00Z] [S5] Another session resume (fresh dispatch, same stopping point).
  Re-read AGENTS.md, briefing, PLAN.md fresh from disk. `git diff master...HEAD --stat` unchanged
  from the previous entry — only `dossiers/TASK-063.md` + `services/control-api/{src,test}/**` in
  the diff, no drift; `git status --porcelain` shows nothing but the non-owned untracked
  `AUTOPILOT_LOG.md`. Independently re-ran verification rather than trusting the prior entry's
  claim:
  - `pnpm --filter @oikonomos/control-api build` — clean, 0 errors.
  - `pnpm --filter @oikonomos/control-api test` WITHOUT `DATABASE_URL`: 3 files passed / 2 skipped,
    40 tests passed / 13 skipped — exact match to the prior session's recorded evidence; confirms
    the DB-gated tests (`edit.route.integration.test.ts`'s 11, `integration.test.ts`'s 2) skip
    cleanly rather than silently passing, everything else green.
  No code changes needed or made. Re-affirming `Status: needs_review` — all ACs previously verified
  true against spec text; full recursive suite (603/603) and canaries (17/17) already proven live
  under DATABASE_URL in a prior session; build and non-DB suite reconfirmed clean this session.

- [2026-08-26T22:55:00Z] [S5] Session resumed via `.devteam/CHECKPOINT.md` (compaction safety net,
  control.mode=strict). Re-read AGENTS.md, briefing, PLAN.md fresh from disk. **This time actually
  read past my own last Progress_Note** — the prior three resume sessions (22:15/22:25/22:32) each
  stopped at "no drift, re-affirm needs_review" without reading the fresh `Review_Findings` entry
  ORCH had appended above those notes. That entry (21:30Z, ORCH opus-4-8 adversarial review) is
  REWORK, not a pass: every originally-stated AC was verified true and mutation-proven, but the
  reviewer found an AC-shaped gap the task's own hazard section forbids — **`expiresAt` is
  caller-supplied with zero bound validation.** A past timestamp was ACCEPTED (200, edited:true),
  invalidating the original and persisting an already-expired, permanently-ungrantable replacement —
  exactly the "invalidated with no usable replacement" hazard this task's own Description names,
  reached through ordinary use, no forced fault needed. A 10-years-out timestamp was equally
  accepted, contradicting Synthesis §5.1's 4h TTL. ORCH's 21:35Z note gave the precise resume
  instruction (also independently confirmed correct after ORCH's 21:40Z note explained the two
  prior identical resubmissions were ORCH's own dispatch-sync bug, not a resume-reading miss on my
  part this time — this session's own `git log` shows the rework-instruction commits `053c0ee` and
  `118a5ad` already present, and PLAN.md's Review_Findings text confirmed genuinely current, not
  stale).

  Implemented exactly as instructed, in `services/control-api/src/app.ts`:
  - New `validateEditExpiresAt(expiresAt, now)` helper (placed after `isRunStatus`, before
    `buildApp`) — rejects a caller-supplied `expiresAt` that is not strictly in the future
    (`<= now`) or that exceeds the platform's own default approval TTL
    (`DEFAULT_APPROVAL_TTL_MS`, imported from `@oikonomos/approvals`'s `issue.ts` barrel export —
    reused the existing constant per the review's explicit instruction, not invented). A value that
    fails to parse to a valid `Date` is deliberately left unvalidated here — `editApproval`'s own
    `resolveExpiresAt` already throws "expiresAt must be a valid Date." for that case and the
    route's existing catch-all already maps it to 400; duplicating that check would just be a
    second implementation of the same validation.
  - Wired into the `POST /approvals/:nonce/edit` handler: when `expiresAt` is present in the body,
    it is parsed to a `Date` and run through `validateEditExpiresAt` **before** `deps.editApproval`
    is ever called. A validation failure returns 400 immediately and never reaches `editApproval` —
    this is what actually satisfies "the original approval left untouched": the invalidate half of
    the atomic operation simply never starts, not merely "rolls back." Renamed the previously-raw
    `new Date(expiresAt)` spread into `deps.editApproval(...)`'s request object to use the
    already-validated `parsedExpiresAt` local, so there is exactly one `Date` construction on this
    path, not two.
  - `expiresAt` omitted (`undefined`) skips the new check entirely — `parsedExpiresAt` stays
    `undefined`, the spread into the `editApproval` request omits the field, and `editApproval`'s
    own `resolveExpiresAt` applies its own default exactly as before. No change to that path.

  OpenAPI (`services/control-api/src/openapi.ts`, OIK-084 fold-in from the same review round):
  added a `400` response entry to both `/approvals/{nonce}/edit` (the new one this task
  introduces — documents the tenant-hard-refusal, identity-rebind-refusal, and the new
  expiresAt-bound-refusal, all previously undocumented) and `/approvals/{nonce}/decide` (review's
  own words: "the sibling /decide route has the same gap, so this is a consistency fix, not a new
  pattern to invent" — in `Owned_Paths` either way, applied the identical treatment). Added a new
  shared `ErrorResponse` schema component (`{ error: string }`, matching the actual `{ error:
  (error as Error).message }` shape both routes' catch-alls already send on the wire) rather than
  inlining an untyped object schema twice.

  Tests added, both fake-backed and live-DB, covering all three legs the new AC specifies:
  - `test/app.test.ts` (+3, fake port): past `expiresAt` → 400 + `deps.calls` empty (proves
    `editApproval` genuinely never invoked, not just that its result was discarded); excessive
    future `expiresAt` (`DEFAULT_APPROVAL_TTL_MS` + 24h) → 400 + `deps.calls` empty; omitted
    `expiresAt` → still 200, `forwarded.expiresAt` is `undefined` (unaffected by the new check).
  - `test/edit.route.integration.test.ts` (+3, live Postgres via `createDatabaseBackedDeps`, real
    `editApproval`): past `expiresAt` → 400, `error` message matches, AND re-reads the original
    approval by nonce afterward — `status: 'pending'`, `destination` still the ORIGINAL value (not
    just "not invalidated" but literally byte-for-byte untouched), AND `listPendingApprovals`
    still shows exactly one pending row for that run+capability, the same nonce as before (this is
    strictly stronger evidence than the unit test: proves no partial DB write happened, not just
    that the HTTP response was 400). Excessive-future `expiresAt` → 400, original still pending.
    Omitted `expiresAt` → 200, re-reads the persisted replacement row and asserts its
    `expires_at` lands within a 60s window of `Date.now() + DEFAULT_APPROVAL_TTL_MS` at the moment
    the request ran (window rather than exact-millisecond match, since `editApproval`'s own clock
    read happens server-side a few ms after the test's `before` timestamp).

  **Full verification run, this session, fresh, nothing trusted from a prior session's claim:**
  - Found the throwaway container `oikonomos-task063-pg` (pgvector/pg16, `127.0.0.1:55481`) still
    running from a prior session (`docker ps -a` showed it `Up`, schema already migrated) — reused
    it rather than starting a second one. Its actual credentials
    (`oikonomos`/`local_test_only`/`oikonomos`, read via `docker inspect ... Config.Env`, NOT the
    `postgres`/`postgres`/`postgres` guess that fails with "password authentication failed") were
    needed to connect — recording this because a future resume session hitting the same auth error
    should inspect the container's real env rather than assume the default-looking connection
    string is right.
  - `pnpm --filter @oikonomos/approvals build` then `pnpm --filter @oikonomos/control-api build` —
    both clean, 0 errors (rebuilt approvals first since the review's own advisory noted
    cross-package integration tests resolve `@oikonomos/approvals` to its `dist/` build, not `src/`
    — stale dist would make a passing test misleading).
  - `pnpm --filter @oikonomos/control-api test` WITHOUT `DATABASE_URL`: 3 files passed / 2 skipped,
    43 passed / 16 skipped (up from the pre-rework 40/13 baseline by exactly the 3 new fake-backed
    tests — confirms nothing else regressed and the new tests are real, not silently skipped).
  - Same command WITH `DATABASE_URL` (real credentials above): **5 files, 59/59 passed, 0
    skipped** — all 14 `edit.route.integration.test.ts` legs ran live (11 pre-existing + 3 new),
    both `integration.test.ts` legs ran live.
  - `pnpm -r test` WITH `DATABASE_URL`: **exit 0, all 16 workspaces green, 609/609** (up from the
    prior 603/603 baseline by exactly the +3 unit +3 integration new tests) — full recursive suite
    per CLAUDE.md's DEVDEPARTMENT amendment, never a filtered per-package run.
  - `pnpm lint` — exit 0, no findings.
  - `pnpm canaries` — 17/17, exit 0, `DATABASE_URL` set (CAN-06/CAN-07 Postgres-atomicity legs ran
    live).
  - `git diff master...HEAD --stat`: only `dossiers/TASK-063.md` +
    `services/control-api/{src,test}/**` (4 src files, 2 test files) — territory clean, no drift,
    no `packages/approvals` touch (protected, consumed exactly as `editApproval` exports it,
    re-confirmed by re-reading `packages/approvals/src/editApproval.ts` at source this session
    rather than trusting the prior sessions' description of it).

  Committing this dossier entry together with the code changes on `task/TASK-063-s5`. All stated
  ACs (original + the two rework ACs added at the 21:30Z review) now independently verified true
  against the spec text, with fresh live-DB evidence gathered this session, not carried forward
  from a stale claim.

  **Status: needs_review.** This is a genuine rework submission — new code, new tests, new
  evidence — not a resubmission of the unchanged `b821054` commit that was correctly rejected at
  21:35Z.
