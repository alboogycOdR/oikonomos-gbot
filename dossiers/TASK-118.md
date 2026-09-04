# TASK-118 — "Always Allow" standing grant from the inline ApprovalCard (Grants-1b)

## Work Log

- [2026-09-04T07:20:00Z] [S5] Session start. Resolved a stale-state mismatch: the
  SessionStart hook and `.devteam/CHECKPOINT.md` both pointed at TASK-120 as
  "active/claimed", but PLAN.md (read fresh from disk, authoritative) shows
  TASK-120 already reviewed and merged (d0ed662) and TASK-118 claimed by S5
  at 05:04:58Z — after TASK-120's merge. Followed the dispatch prompt (task =
  TASK-118, do not re-claim/re-branch) per AGENTS.md's "files are the truth"
  rule. Deleted the stale checkpoint. No local `task/TASK-118-s5` branch
  existed yet, so created it fresh from `mainco/master` (699ac23, which has
  TASK-117 merged and TASK-118 dispatched) — this is the one-time branch
  creation the dispatch prompt allows for a freshly claimed task.

- [2026-09-04T07:45:00Z] [S5] Implemented the backend half, fully within
  Owned_Paths:
  - `services/control-api/src/app.ts`: added `POST /roles/:roleId/grants`
    (schema-validated `capabilityId`/`maxTier` against the real `riskTiers`
    enum, 400 on garbage tier values) calling `deps.upsertRoleGrant` — covered
    by the existing global fail-closed auth preHandler, no `public: true`
    override added.
  - Extended `GET /threads/:id/messages`'s approval projection to add
    `capability_id`/`max_tier` (previously `{nonce, action_render, status}`
    only), per the task description's explicit instruction to extend it.
    `max_tier` is sourced from the capability's own registered `defaultTier`
    (`deps.listCapabilities()`) — **not** a tier stored on the approval
    itself. `packages/db/src/approvals.ts` (outside Owned_Paths) has never
    persisted the tier an approval was raised at; `defaultTier` is the only
    tier source reachable from this task's territory, and it's exactly what
    TASK-117's own built-in-grant path already uses as its ceiling, so this
    is a consistent choice, not an ad hoc one. `max_tier` is `null` if the
    capability is no longer registered.
  - `services/control-api/src/ports.ts`: no changes needed — `upsertRoleGrant`
    was already on `ControlApiDeps` (TASK-117).

- [2026-09-04T08:05:00Z] [S5] Tests (`services/control-api/src/chat.routes.test.ts`,
  owned via the `**/*.test.ts` pattern): 401-without-session for the new
  route; schema-validated 400 on a bogus `maxTier`; a fake-deps test proving
  the route calls `upsertRoleGrant` with the exact body and 201s the result;
  two projection tests (capability_id/max_tier present when the capability
  is registered, `max_tier: null` when it isn't); and a **real Postgres**
  integration test (`DATABASE_URL`-gated, ran for real this session) that
  posts to the live endpoint and then reads the persisted `role_grants` row
  back via `Database.getRoleGrant` — requesting a tier deliberately
  *different* from `fs.read`'s real default so the assertion proves this
  endpoint's own write produced the row, not TASK-117's creation-time
  default (mirrors TASK-117's own "non-default tier" proof pattern).

- [2026-09-04T08:15:00Z] [S5] **Ownership gap found and worked around, not
  silently fixed** — flagging explicitly since it affects two of this task's
  ACs. `ApprovalCard`'s "Always Allow" needs `roleId` (the endpoint's path
  param) plus the approval's `capabilityId`/`maxTier` to call the new route.
  None of these reach `ApprovalCard` today:
  - `apps/dashboard/src/components/chat/types.ts`'s `ApprovalRender` has no
    `capabilityId`/`maxTier` fields.
  - `apps/dashboard/src/pages/ChatPage.tsx`'s `toChatMessage`/`toBotSummary`
    only forward `nonce`/`actionRender`/`status` into `ApprovalRender`, and
    map `BotSummary.id` to **`thread.id`**, not `roleId` — so even `roleId`
    itself doesn't reach `ConversationPane`/`ApprovalCard` today.
  - `apps/dashboard/src/components/chat/ConversationPane.tsx`'s call site
    (`<ApprovalCard approval={message.approval} onUnauthorized={...} />`)
    passes neither field.
  None of `types.ts`, `ChatPage.tsx`, `ConversationPane.tsx` are in this
  task's `Owned_Paths` (only `ApprovalCard.tsx`/`.test.tsx`, `lib/api.ts`,
  and the two control-api files are). Per AGENTS.md commandment 4, did not
  touch them. Instead:
  - `lib/api.ts` (owned): extended `ThreadMessage.approval`'s type with the
    server's real `capability_id`/`max_tier` fields (server-side plumbing is
    now 100% ready), and added `createRoleGrant(roleId, capabilityId,
    maxTier)`, mirroring `decideApproval`'s error-shape handling.
  - `ApprovalCard.tsx` (owned): added an optional `roleId` prop and widened
    `approval` to accept optional `capabilityId`/`maxTier` via a **local**
    extended type (does not touch the shared `ApprovalRender` in
    `types.ts`). "Always Allow" renders only when all three are present
    (`canAlwaysAllow`) — degrades to hidden, not a broken button, until a
    follow-up task wires the three missing files. When it renders, clicking
    it (1) calls the exact same `decideApproval(nonce, "granted")` "Approve"
    uses — reused, not duplicated — then (2) calls `createRoleGrant`. Nonce
    discipline (TASK-109) is unchanged: the nonce is only ever sent in the
    one decide call's body, never in the grant call, URL, history, or
    storage — asserted directly in the new test.
  - Component tests cover both states: hidden when the data isn't there
    (today's real production shape, since nothing forwards it yet), and the
    full decide+grant flow plus nonce discipline plus the 409 path when
    it is.

  **This is why the task is going to `needs_review` rather than fully
  closed-loop `done`-ready on every AC**: AC #2/#3 ("tested against real
  Postgres end-to-end … via the always-allow path") are proven at the
  control-api layer (real Postgres, real row written and read back) and at
  the component layer (real fetch mocks, full flow, real nonce-discipline
  assertions) — but not as one true end-to-end click-through in the running
  app, because the button is provably unreachable in production until
  `types.ts`/`ChatPage.tsx`/`ConversationPane.tsx` get the three-field
  threading this dossier just described. Recommend a small immediate
  follow-up task (or a scope note on this one) owning exactly those three
  files to finish the wiring — the hard parts (schema, endpoint, tests,
  component logic, nonce discipline) are all done and green.

- [2026-09-04T08:25:00Z] [S5] Full verification: `pnpm --filter
  @oikonomos/control-api test` 116/116 (includes the new real-Postgres
  integration test, ran for real — `DATABASE_URL` was set this session).
  `pnpm --filter @oikonomos/dashboard test` 60/60 (includes the 3 new
  ApprovalCard tests). `pnpm lint` clean. `pnpm -r build` 17/17 clean
  (includes dashboard `vite build`). `pnpm -r test` (full recursive, per
  CLAUDE.md's amended review standard): one failure,
  `services/worker/src/registerCapabilities.test.ts`'s PostgreSQL
  idempotency test (a `description` field mismatch from concurrent
  capability-registration runs against the shared dev Postgres) —
  re-ran in isolation (`pnpm --filter @oikonomos/worker test --
  src/registerCapabilities.test.ts`) and it passed clean, 38/38 (1 skipped),
  confirming a transient shared-DB contention flake, not a regression from
  this diff (no file this task touched is anywhere near that test's
  surface). Handing to `needs_review` with the ownership-gap note above.
