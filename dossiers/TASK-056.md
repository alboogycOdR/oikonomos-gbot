# TASK-056 dossier

## Brief
`services/control-api` — Fastify service exposing `POST /tasks`, `GET /runs`,
`GET /runs/:id`, `GET /approvals` (pending), `POST /approvals/:nonce/decide`
(approve|reject), `GET /runs/:id/evidence`. All persistence must go through
`@oikonomos/db` and `@oikonomos/approvals` public APIs — no raw SQL in this
service (N9-style lint). Approval decide MUST delegate to the existing
`packages/approvals` verify+consume path, never reimplement nonce handling.
OpenAPI served at `/openapi.json`. Critical priority — every other surface
(TASK-057/058/059) consumes this, not the DB.

## Session 1 — 2026-08-20

### Setup / sync
- Session-start hook and `.devteam/CHECKPOINT.md` both referenced a stale
  TASK-048 (already merged to master at 68520b9, visible in `git log`). My
  actual dispatch prompt + PLAN.md (main checkout) confirm the real
  assignment: **TASK-056**, reassigned CX→S5 under protocol §7 triage
  (CX hit a provider usage limit; ORCH quarantined a fabricated control
  block — pack finding #17 — and reset claim to `pending` for a clean S5
  claim). Deleted the stale `.devteam/CHECKPOINT.md` per resume procedure.
- Worktree HEAD was detached at 68520b9 with a stale local `PLAN.md`
  (plan_version 4.0 vs origin's newer claim commits). Created
  `task/TASK-056-s5` from `origin/master` (0d80c34, which already carries
  the claim record) so the branch starts from current PLAN.md/history
  without me writing PLAN.md myself (control.mode=strict — I never touch
  PLAN.md this session; state changes go through the `devteam-control`
  block only).

### Pre-flight (c8b9872 evidence)
```
[preflight] TASK-056 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-s5-oikonomos
[preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   services/control-api/src/**  -> 1 file(s):
           services/control-api/src/index.ts
  GLOB   services/control-api/test/**  -> matches nothing yet (new territory)
  FILE   services/control-api/package.json  -> exists, 28 line(s), 619 bytes
```

### Investigation — public API surface of @oikonomos/db and @oikonomos/approvals

The task description is explicit and non-negotiable: *"All persistence via
`@oikonomos/db` and `@oikonomos/approvals` public APIs — no raw SQL here
(N9-style lint)"* and *"do not reimplement nonce handling"*. Both packages
are Owned_Paths of TASK-056 is `services/control-api/**` only — `packages/db`
and `packages/approvals` are protected paths I cannot touch even if I wanted
to (different-model adversarial review requirement, and simply outside my
territory regardless).

I read every exported symbol from both packages' barrels
(`packages/db/src/index.ts`, `packages/approvals/src/index.ts`) and every
source file behind them (`database.ts`, `runs.ts`, `approvals.ts`,
`auditEvents.ts`, `capabilities.ts`, `types.ts`, `seedInboxTriage.ts` for db;
`bind.ts`, `consume.ts`, `issue.ts`, `nonce.ts`, `render.ts`, `store.ts`,
`sweep.ts` for approvals) to build a complete inventory of what is actually
callable without raw SQL. Full export list confirmed via
`grep -n "^export" packages/db/src/*.ts packages/approvals/src/*.ts`.

**What exists:**
- `runs`: `startRun`, `getRun(id)` (single), `resumeRun`, `failRun`,
  `cancelRun`. No list/query-by-filter function.
- `approvals`: `insertApproval` (always lands `pending`),
  `getApprovalByNonce(nonce)` (single), `consumeApproval`/`verifyAndConsume`
  (only transitions `granted → consumed`, atomically, exactly what N8/the
  decide-approve path needs). `store.ts` also has `invalidateApproval`
  (`granted → invalidated`) and `expirePendingApprovals`
  (`pending → expired`), but these are **not exported from the barrel**
  (`packages/approvals/src/index.ts`) — `invalidate`/`expirePending` are only
  reachable through the internal `ApprovalStore` object, not as public
  top-level functions control-api could import.
- `auditEvents`: `insertAuditEvent` only — write-only, no read/list.
- `capabilities`/`Database` class: capability + role-grant CRUD, unrelated
  to tasks/runs/approvals/evidence.
- **`tasks` table has no db module at all.** The table exists in the schema
  (`infra/postgres/migrations/001_schema_v1.up.sql`) but
  `packages/db/src/*.ts` never references it — confirmed via
  `grep -rn "tasks" packages/db/src/*.ts` (zero hits beyond the migration
  files) and `grep -rn "createTask|insertTask|NewTask"` across the whole
  repo (zero hits anywhere).

**What TASK-056's acceptance criteria require that does not exist yet:**
1. **`POST /tasks`** — no `createTask`/`insertTask` function exists in
   `@oikonomos/db` for the `tasks` table at all. Nothing to call.
2. **`GET /runs`** (list) — only `getRun(id)` (single row) exists; no
   list-runs / list-by-status query.
3. **`GET /approvals`** (list pending) — only `getApprovalByNonce(nonce)`
   (single row) exists; no list-pending-approvals query.
4. **`POST /approvals/:nonce/decide` (approve|reject)** — two problems:
   - `verifyAndConsume` (the correct, spec-mandated N8 path) only
     transitions an approval that is **already `granted`** to `consumed`.
     There is no exported function anywhere that transitions
     `pending → granted` — i.e. nothing implements "approve" itself, only
     "consume an already-approved decision". `decide(approve)` has no
     public API path.
   - `reject` has no exported transition function either. `invalidate`
     (`granted → invalidated`) exists in `store.ts` but is not exported
     from the package barrel, and semantically it invalidates a granted
     approval (the OIK-023 digest-mismatch case), not "reject a pending
     one" — a different transition (`pending → rejected`) that doesn't
     exist anywhere.
5. **`GET /runs/:id/evidence`** — `insertAuditEvent` is write-only; no
   `getAuditEventsForRun`/list-by-run function exists to read evidence
   back out.

I confirmed I'm not missing a lower-level escape hatch: `database.ts`
exposes a `Database` class, but its only methods are capability/role-grant
CRUD (`getCapability`, `listCapabilities`, `upsertCapability`,
`getRoleGrant`, `listRoleGrants`, `upsertRoleGrant`) — nothing for
tasks/runs/approvals/audit. There is no generic `query()` escape hatch
exported either; the only way to touch these tables from outside `db`/
`approvals` themselves is raw SQL, which the task explicitly forbids.

### Why this blocks rather than proceeding
The task is unambiguous that control-api must not contain raw SQL and must
not reimplement nonce/approval handling. Implementing `POST /tasks`,
`GET /runs`, `GET /approvals`, or either half of the decide endpoint would
require either (a) raw SQL in this service — a direct acceptance-criterion
violation and an N9-style lint violation — or (b) adding the missing
functions to `packages/db`/`packages/approvals` myself, which is outside
`Owned_Paths` (`services/control-api/**` only) and those two packages are
separately protected paths requiring different-model adversarial review
that only ORCH can arrange. Reaching into either is exactly the "just an
import" trap `AGENTS.md` rule 4 and the briefing's "Shared infrastructure"
section warn against. I am not proceeding on a partial implementation that
fakes/stubs the missing persistence calls, since that would misrepresent
Test_Evidence for acceptance criteria that cannot actually be met yet.

### What I did NOT touch
No files written under `services/control-api/**` yet (investigation only,
no code changes this session) and no PLAN.md edits (control.mode=strict).

### Next step for whoever picks this back up
Either:
- ORCH/GB/CX add to `packages/db` (single-owner, protected-path task): a
  `createTask`/`getTask`/`listTasks`-style module for the `tasks` table,
  `listRuns` on top of `runs.ts`, `listPendingApprovals` on top of
  `approvals.ts`, and `getAuditEventsForRun` on top of `auditEvents.ts`; and
  to `packages/approvals`: export a `grantApproval` (`pending → granted`)
  and `rejectApproval` (`pending → rejected`) transition from the barrel
  (or a decide-dispatch helper that wraps both plus the existing
  `verifyAndConsume` for the approve+consume leg) — **then** TASK-056 can
  implement all six endpoints purely against public APIs as specified.
- Or ORCH decides raw SQL / a widened Owned_Paths is acceptable for this
  task specifically and says so explicitly, superseding the task
  description's own "no raw SQL" instruction.

I'm blocking rather than guessing which of those ORCH prefers.

## Session 2 — 2026-08-22 (resume after TASK-061/062 unblocked the task)

### Starting state
ORCH's TASK-061 round-4 review note confirms both prerequisites (TASK-061
db read/CRUD, TASK-062 approvals grant/reject) merged to master, unblocking
this task. Resumed on the existing `task/TASK-056-s5` branch (not
re-claimed/re-branched). Found substantial prior work already on the
branch as commit `ff925d6` — an ORCH safety-net "wip" commit explaining a
prior S5 session was killed by the harness mid-work before it could finish
or emit a control block: `app.ts`, `ports.ts`, `openapi.ts`, `redact.ts`,
`index.ts`, and all four test files already existed, implementing all six
endpoints against the `ControlApiDeps` port (delegating to `@oikonomos/db`
and `@oikonomos/approvals` public functions only, per TASK-061/062's new
exports). No dossier entry existed yet for that work since the session was
killed before it could write one — recording it now.

### Verification performed this session
1. **Full control-api suite without `DATABASE_URL`**: 31 passed, 2 skipped
   (integration.test.ts's two DB-gated cases, correctly `describe.skip`'d
   per the TASK-035/044 precedent comment in the file).
2. **Found an existing throwaway Postgres container** (`oik-task056`,
   port 55471, schema `001_schema_v1` already applied — verified via
   `\dt`) left running from the killed session. Exported
   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55471/postgres`
   and re-ran: **33/33 pass, 0 skipped** — both integration legs
   (`POST /tasks` → `startRun` → `GET /runs` → `GET /runs/:id` →
   `insertAuditEvent` → `GET /runs/:id/evidence`, and
   `GET /approvals` → `POST /approvals/:nonce/decide` → repeat-decide 409)
   actually executed against real Postgres, not skipped (TASK-035/044
   "a skipping DB test is not evidence" precedent satisfied).
3. **MUTATION-PROVEN the delegation claim** (AC: "a local reimplementation
   of the nonce check turns a test RED"). `decide.route.test.ts`'s own
   header comment asserted this but the dossier had no record of it
   actually being run — closed that gap: backed up `app.ts`, replaced the
   `/approvals/:nonce/decide` handler body with a naive local
   reimplementation that always returns `200 { decided: true }` without
   calling `deps.decideApproval` at all (bypassing the packages/approvals
   status-guarded transition entirely), re-ran the suite: **6 tests went
   RED** (double-decide-rejected, double-decide-approve-then-reject,
   expired-row-refused, unknown-nonce-refused, plus 2 more in the same
   file) — the mutation is caught. Restored `app.ts` from the backup
   byte-for-byte (`cp` from `/tmp/app.ts.bak`, confirmed via re-running the
   suite green again, 31/33 pass/2 skip with no `DATABASE_URL`). No trace
   of the mutation left in the working tree or any commit.
4. **`pnpm -r test` (full recursive suite, `DATABASE_URL` set)**: every
   workspace package green. One transient failure on first run —
   `packages/harness-factory`'s `test/sole-constructor.test.ts` (N9 sole
   harness-constructor guard) failed because a stray, **untracked**
   `apps/__sole-constructor-fixture__/stray.ts` fixture file was already
   sitting on disk before this session started (visible in the very first
   `git status --porcelain` this session, alongside `AUTOPILOT_LOG.md`) —
   leftover from that package's own self-cleaning test fixture, presumably
   orphaned by the same harness-kill that produced the `wip` commit on
   *this* branch. That file is entirely outside `services/control-api/**`
   (outside my `Owned_Paths`, and `packages/harness-factory` is a
   protected path besides) — I did not touch it. Re-ran
   `pnpm --filter @oikonomos/harness-factory test` in isolation: the
   test's own second case cleans up the fixture in its `finally` block,
   the file is now gone from disk, and a follow-up `pnpm -r test` came
   back **fully green across all packages** (confirmed 3 workspace
   packages' Test Files/Tests counts explicitly, plus grepped the whole
   run for `fail`/`✗` — zero hits). Recording this so the transient is
   understood rather than silently ignored, per this project's "no silent
   caps" norm — it was pre-existing environmental cruft, not a regression
   I introduced or masked.
5. **`pnpm lint`**: found and fixed one pre-existing warning in my own
   territory — an unused `eslint-disable-next-line no-console` in
   `index.ts`'s bootstrap catch handler (the rule apparently isn't firing
   there under this project's config, so the directive was dead). Removed
   the directive; `pnpm lint` now reports 0 errors, 0 warnings, exit 0.
   Committed separately (`d44d892`).
6. **`pnpm --filter @oikonomos/control-api typecheck`**: clean.
7. **`pnpm canaries`**: 17/17 pass (with `DATABASE_URL` set, including the
   two Postgres-backed CAN-06/CAN-07 atomicity canaries).

### Acceptance criteria cross-check
- All six endpoints implemented + route-tested + OpenAPI: ✅ —
  `openapi.ts` documents `/tasks`, `/runs`, `/runs/{id}`,
  `/runs/{id}/evidence`, `/approvals`, `/approvals/{nonce}/decide`;
  served at `GET /openapi.json` (asserted in `app.test.ts`).
- Zero raw SQL, all persistence via `@oikonomos/db`/`@oikonomos/approvals`:
  ✅ — `ports.ts` is the sole import site for both packages; no other
  source file imports either. `test/no-raw-sql.test.ts` is a liveness
  control (scans for `pg` imports and bare SQL keywords across every
  source file, plus a package.json dependency check, plus a self-check
  that the scanner itself would catch a planted `pg` import) — satisfies
  the CLAUDE.md "every mechanical control ships a liveness assertion"
  rule.
- Decide route delegates to packages/approvals, mutation-proven: ✅ —
  verified live this session, see item 3 above.
- Double-decide tested: ✅ — `decide.route.test.ts` and the live-Postgres
  `integration.test.ts` both assert second-decide → 409.
- Approvals route bodies/nonce redacted in logs, tested: ✅ —
  `app.test.ts`'s "N4 log redaction" case captures real pino output via
  an injected `logStream` and asserts the nonce string never appears in
  it; `redact.ts`'s URL-path redaction is unit-tested separately.
- `pnpm -r test`, `pnpm lint`, `pnpm canaries` all exit 0: ✅ — all
  verified this session per items 4–7 above.

### What I did NOT touch
`pnpm-lock.yaml` (300 lines added by pnpm for the `fastify` dependency)
remains **uncommitted** — it is outside `Owned_Paths` (root file, not
under `services/control-api/**`) per the task description's explicit
instruction ("never touch the root package.json or the lockfile beyond
what pnpm writes for your package"); leaving it for ORCH to apply at
merge, same pattern TASK-061 used for its persistence-surface pin.
`apps/__sole-constructor-fixture__/` and `AUTOPILOT_LOG.md` untouched
(pack/harness infrastructure, not this task's territory). No PLAN.md
edits (control.mode=strict).

## Work Log
- [2026-08-20T14:40:00Z] [S5] Session start, resolved stale checkpoint/hook
  state (TASK-048 already merged), confirmed real assignment TASK-056 from
  PLAN.md. Preflight run and pasted above. Read the entirety of
  `@oikonomos/db` and `@oikonomos/approvals` public surfaces. Found five
  concrete missing-function gaps (tasks CRUD entirely absent; no list-runs;
  no list-pending-approvals; no pending→granted/pending→rejected approval
  transitions; no audit-event read path) that make all six endpoints
  unimplementable without raw SQL or out-of-territory edits. Blocking
  MISSING_DEPENDENCY with the precise gap list above. No code written, no
  PLAN.md touched.
- [2026-08-22T11:25:00Z] [S5] Resumed after TASK-061/062 merged and
  unblocked this task. Found all six endpoints already implemented on the
  branch from a prior killed session (ORCH's `wip` safety-net commit
  `ff925d6`). Verified the full suite live against a real Postgres
  (33/33, 0 skipped), mutation-proved the decide route's delegation to
  `@oikonomos/approvals` (6 tests turn RED with a naive local
  reimplementation, cleanly reverted), confirmed `pnpm -r test`/
  `pnpm lint`/`pnpm canaries` all exit 0 (one transient harness-factory
  failure traced to pre-existing untracked cruft outside my territory,
  self-cleaned, re-verified green), fixed one pre-existing lint warning in
  my own territory. All six acceptance criteria confirmed against the
  spec text. Ready for review.
