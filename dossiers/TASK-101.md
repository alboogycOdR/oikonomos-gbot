# TASK-101 Dossier — S5

## Task
services/control-api — session auth gate + GET /tasks ⚑ security-relevant, adversarial review required

## Work Log

- [2026-09-02T12:30:00Z] [S5] Session start (resume). Deleted stale `.devteam/CHECKPOINT.md`
  (referenced TASK-050, already merged/done — not relevant to this task). Read AGENTS.md,
  PLAN.md TASK-101 block, dossiers/TASK-101.md (did not exist — created here), and the
  current `services/control-api` source tree.

  **Design investigation:**
  - `GET /tasks` acceptance criterion is straightforward: `@oikonomos/db`'s `listTasks()`
    (packages/db/src/tasks.ts) already exists with the exact same
    tenantId/status/limit/cursor filtering shape as `listRuns` — just needs wiring through
    `ports.ts` (`ControlApiDeps.listTasks`) and a new route in `app.ts`, mirroring the
    existing `GET /runs` route+schema exactly. No conflict, straightforward addition.
  - Auth gate: read `services/control-api/test/*.test.ts` (app.test.ts,
    decide.route.test.ts, edit.route.integration.test.ts, integration.test.ts). **All of
    them call `buildApp(deps, { logger: false })` and then `app.inject(...)` against
    protected routes (`/tasks`, `/runs`, `/approvals/:nonce/decide`,
    `/approvals/:nonce/edit`, etc.) with NO `Authorization` header and NO session cookie**,
    and assert 200/201/409 responses. Per this task's own Description and AC #1, a valid
    global auth preHandler must deny (401) any request lacking a valid bearer
    token/session — which is precisely what these existing tests do not send.
  - **This is a hard ownership conflict, not a design choice I can route around while
    staying fail-closed** (CLAUDE.md N3 "fail closed" + this task's AC #5 LIVENESS
    requirement that removing the auth preHandler must turn the 401 tests RED — i.e. the
    gate must be REAL, unconditionally applied to existing routes, not opt-in/env-gated to
    dodge old callers). Making the gate default-permissive when `CONTROL_API_TOKEN` is
    merely unset in a test process — so the pre-existing tests keep passing unauthenticated
    — is exactly the fail-open misconfiguration posture N3 forbids, and it would make the
    LIVENESS check meaningless (the 401 tests would only be the ones I add myself, not the
    pre-existing route tests actually exercising `/tasks`, `/runs`, `/approvals/...`).
  - The only correct fix is to update the four pre-existing test files under
    `services/control-api/test/` so their `buildApp`/`app.inject` calls carry a valid
    bearer token (or pre-authenticate via `/auth/login`) once the gate exists. Those files
    are **not** in this task's `Owned_Paths`
    (`services/control-api/src/auth.ts`, `src/auth.test.ts`, `src/app.ts`, `src/ports.ts`
    only — `test/**` is excluded). Editing them would violate AGENTS.md commandment 4
    (territory) and this task's own AC #6 (`pnpm -r test` must exit 0 — which a correctly
    fail-closed gate would break for these files as they stand today).
  - No code changes committed. Blocking now rather than guessing at a workaround that
    would either weaken the security control (fail-open default) or silently break/skip
    tests I don't own.

**Status: blocked.** See `Blocked_Reason` in the control block below.

**Next step for whoever picks this back up (ORCH or a re-scoped dispatch):** either (a)
add `services/control-api/test/**` to this task's `Owned_Paths` so the auth-gate rollout
can update the four affected test files' `buildApp`/`inject` calls to authenticate, or
(b) split off a follow-up task explicitly owning `test/**` test-fixture updates,
sequenced after this one via `Depends_On`.
