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
