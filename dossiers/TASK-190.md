# TASK-190 — Security: enforce tenant ownership on every by-id route (cross-tenant IDOR)

Owned_Paths: services/control-api/src/app.ts, services/control-api/src/app.test.ts (or existing per-route
test files — skills.routes.test.ts, chat.routes.test.ts, sse.test.ts), packages/db/src/skills.ts,
packages/db/src/runs.ts, packages/db/src/threads.ts.

## Work Log

- [2026-09-06T01:25:00Z] [S5] Resumed after a stale checkpoint pointed at the wrong task (TASK-177,
  already merged) — confirmed via PLAN.md fresh from disk that the actually-claimed task is TASK-190.
  Re-created the branch cleanly from `mainco/master` (which already has TASK-177 merged) rather than
  reusing the old worktree's `task/TASK-177-s5` checkout, which had unrelated uncommitted leftovers
  (stashed, not touched further — they belong to a different task/branch).

  **Audit (per the task's own "audit first, fix second"):**
  - `packages/db/src/skills.ts` `getSkill`/`updateSkill`: SQL has no tenant filter at all — real gap.
  - `packages/db/src/runs.ts` `getRun`: same — no tenant filter — real gap. `GET /runs/:id/evidence`
    didn't even fetch the run first; called `getAuditEventsForRun` directly off the bare URL id.
  - `packages/db/src/threads.ts`: **no `tenant_id` column on `threads` at all** — ownership is only
    derivable transitively through `role_id` (1:1 threads) or `thread_members` (group threads). Real
    gap on `GET /threads/:id/messages` (didn't even check the thread exists), `POST
    /threads/:id/messages`, `POST /threads/:id/attachments`, `GET /threads/:id/stream`.

  **Fixed (within confirmed Owned_Paths — see blocker below for why threads is not):**
  - `GET /skills/:id`, `PATCH /skills/:id`: approach (b) — compare `skill.tenantId` to
    `request.tenantId` in the route handler, 404 (never 403) on missing OR cross-tenant. PATCH checks
    ownership via a `getSkill` pre-fetch before calling `updateSkill`, so a cross-tenant PATCH never
    reaches the write.
  - `GET /runs/:id`, `GET /runs/:id/evidence`: same approach — `run.tenantId` check; `/evidence` now
    resolves+checks the run before calling `getAuditEventsForRun` at all (previously called it
    unconditionally with zero existence check).
  - Did NOT add a `tenantId` parameter to any `ControlApiDeps` method (approach (a), the task's
    stated preference) — `ports.ts` is outside Owned_Paths and `ControlApiDeps.getRun`/`getSkill`'s
    interface signatures live there; widening them there to accept the extra arg would be an
    out-of-territory edit. Documented this deviation inline in `app.ts` at both call sites.

  **BLOCKED (not fixed this session) — `packages/db/src/threads.ts` and its by-id routes:**
  Attempted the same approach for threads (derive ownership via `deps.listRoles({tenantId})` against
  `thread.roleId`/`memberRoleIds`, requiring EVERY group-thread member role to match). Implemented it,
  then ran the FULL suite per CLAUDE.md's amendment and found it broke 3 pre-existing tests in
  `chat.routes.test.ts` (group-thread fan-out/attribution tests whose fixtures don't provide a
  `listRoles` role for their group-thread member ids) and 2 in `sse.test.ts` (its default
  `ControlApiDeps` fixture's `listRoles` returns `[]`, no matching role for `roleId: "bot"`). Those
  fixtures need updating in lockstep with the route fix — but:
  - `services/control-api/src/chat.routes.test.ts` and `services/control-api/src/sse.test.ts` are
    named in this task's own Description prose ("per-route test files as they already exist") but
    NOT matched by the territory-firewall hook: confirmed mechanically — every `Edit` attempt on
    either file was BLOCKED this session.
  - `packages/db/src/threads.ts` itself — named directly in `Owned_Paths` — was ALSO mechanically
    blocked on every `Edit` attempt.
  - Root cause, confirmed with a one-off `node -e` probe of `hooks/lib.js`'s `ownedPathsOf()`: it
    splits the `Owned_Paths` field on every comma, including commas inside this task's own
    parenthetical prose. `"...app.test.ts (or per-route test files as they already exist — grep...),
    packages/db/src/skills.ts"` splits BEFORE the closing paren's comma, so the whole parenthetical
    becomes one giant literal glob token that matches no real file — and separately,
    `"packages/db/src/threads.ts (add tenant-checked variants ... first, some may already ...)"` has
    an internal comma that splits `threads.ts` itself away from its own path, corrupting that token
    too. Net effect: only `app.ts`, `packages/db/src/skills.ts`, and `packages/db/src/runs.ts` are
    mechanically writable, despite the field's own prose describing a wider, sane-sounding scope.
  - Reverted the threads.ts-adjacent app.ts route changes and their tests rather than ship an
    untested (and, per the full-suite run, test-breaking) fix. Left in-code comments at each
    `/threads/:id/*` route pointing at this dossier entry and naming the exact design
    (`threadBelongsToTenant`, preserved as a documented stub) so a follow-up session doesn't have to
    re-derive it.

  **Tests added (all within confirmed Owned_Paths):**
  - Originally added the two skills cross-tenant cases to `services/control-api/src/skills.routes.test.ts`
    directly — that `Edit` was NOT blocked at the time, but committing it WAS: the separate
    `hooks/territory-precommit.js` pre-commit hook rejected the staged file with the identical
    Owned_Paths mismatch. Re-verified with a fresh trivial `Edit` afterward and it was rejected too
    (the earlier pass-through was some kind of transient/caching fluke, not a real allowance) — so
    this file is genuinely outside territory by both enforcement points, not just one. Reverted the
    diff (`git checkout --`) rather than ship something uncommittable.
  - All four new cross-tenant cases (`GET /skills/:id`, `PATCH /skills/:id`, `GET /runs/:id`,
    `GET /runs/:id/evidence`) now live in `services/control-api/src/app.ts`'s own
    `if (import.meta.vitest)` block instead (this service's shared vitest config already sets
    `includeSource: ["src/**/*.ts"]`, the same mechanism `packages/db/src/skills.ts` etc. use) —
    same own-tenant/cross-tenant/never-403/never-reaches-the-write shape as originally written, just
    relocated to a file that is unambiguously and consistently mine.

  **Full verification (CLAUDE.md's "always run the FULL recursive suite" amendment):**
  - `services/control-api`: `pnpm run test` (own package script, real Postgres) — 176 passed, 1
    failed. The 1 failure (`skills.routes.test.ts` real-Postgres PATCH round trip, `expected 400 to
    be 200`) reproduces byte-identical on `git stash` (i.e. on unmodified `mainco/master` post-TASK-177
    merge) — confirmed pre-existing, not caused by this session's diff.
  - `pnpm -r build` (all 18 packages/services): clean.
  - `pnpm lint`: clean.
  - `pnpm -r test` (full monorepo): stopped at first failure per pnpm's default (`services/worker`'s
    `workerJobQueue.test.ts` pg-boss timing test) — re-ran in isolation, passed clean (6/6), confirming
    a timing flake, not a regression. Continued with `pnpm --filter="!@oikonomos/worker" -r test`:
    `packages/approvals` hit a single `Test timed out in 5000ms` on an unrelated real-Postgres
    concurrency test; re-ran in isolation, passed clean — same documented Postgres-contention flake
    class as prior sessions' notes (TASK-162/175/177). Every other package
    (db, policy, memory, agent-providers, sandbox-client, shared, connectors, audit, harness-factory,
    workspace, broker, evals/golden, evals/harness, gateway-telegram, dashboard) passed 100% clean.
  - `grep -rn "bypassPermissions|acceptEdits"` over touched files: clean.

  **Status → `blocked`.** `Blocked_Reason: OWNERSHIP_CONFLICT` — need write access to
  `services/control-api/src/chat.routes.test.ts`, `services/control-api/src/sse.test.ts`, and
  `packages/db/src/threads.ts` to finish the `/threads/:id/*` by-id routes (the remaining item from
  this task's own audit list). Recommend ORCH either (1) re-carve this task's `Owned_Paths` as a
  clean comma-separated path list with rationale moved to `Description` instead of inline
  parentheticals, so `ownedPathsOf()`'s naive comma-split stops corrupting the intended file list, or
  (2) fix `hooks/lib.js`'s `ownedPathsOf()` to be robust to commas inside `Owned_Paths` prose (e.g.
  require each token to look like a real path/glob, or split more conservatively). Either fix is a
  `hooks/**`/PLAN.md-adjacent change outside my own territory — flagging, not attempting.
