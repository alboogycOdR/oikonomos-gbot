# TASK-122 — Group thread UI + fan-out approval rule (Chat-2c)

## Work Log

- [2026-09-04T09:05:00Z] [S5] Resumed after a context-compaction checkpoint
  that was stale (pointed at TASK-124, already merged/done). Re-read
  PLAN.md fresh: TASK-122's own dependencies (121/123/124) were all done.
  Rebuilt worktree from `mainco/master` (`9d0d102`), created
  `task/TASK-122-s5` fresh (previous local branch was still on the old
  `task/TASK-124-s5`).

- [2026-09-04T09:40:00Z] [S5] Implemented and tested. Summary:

  **Frontend (group thread UI + attribution):**
  - `lib/api.ts`: added `GroupThread`, `isGroupThread()` type guard,
    `createGroupThread()` (`POST /threads/group`), and
    `senderRoleId`/`senderName` on `ThreadMessage` — mirroring TASK-121's
    real `app.ts` response shapes exactly.
  - `GroupThreadDialog.tsx` (new): mirrors `CreateBotDialog.tsx`
    (TASK-110)'s own pattern — multi-select existing bots (2+ required
    client-side), `POST /threads/group`, then `window.location.reload()`
    so `ChatPage`'s existing mount effect lands on the new group thread.
    Wired into `BotSidebar.tsx` via a new "+ New group" button next to
    "+ New bot".
  - `ChatPage.tsx`: `toBotSummary`/`toChatMessage` now branch on
    `isGroupThread()` and carry sender attribution through.
  - `ConversationPane.tsx`: each bot message is now labelled with its own
    sender's name (`message.senderName ?? bot.name`) instead of assuming
    a single bot — `MessageBubble.tsx` itself is untouched, since it
    already accepts an arbitrary `botName` per call.
  - `BotSidebar.tsx`: group threads render with a 👥 marker; the "New
    group" dialog only offers real (non-group) bots.
  - `ChatShell.tsx`: `ComposeBox` is disabled for a group thread (see
    "Known gap" below for why, rather than leaving a broken send).

  **Territory note — group-thread awareness without editing `types.ts`:**
  `components/chat/types.ts` is not in this task's `Owned_Paths` (only
  the five specific component files + `GroupThreadDialog.*` + `ChatPage.tsx`
  + `lib/api.ts` + the worker files are). Rather than block on that, every
  file that needs to know "is this a group / who sent this" declares its
  own local structural-extension interface (`GroupAwareBotSummary`,
  `GroupAwareChatMessage`) and casts — TypeScript's structural typing
  accepts the extra fields on a variable typed as the base `BotSummary`/
  `ChatMessage` without a literal-object excess-property error. No cross
  section of `types.ts` was touched; every consumer of the plain type
  (e.g. existing `ApprovalCard`) is unaffected.

  **Backend fan-out rule (`chatRunDriver.ts`):**
  - `deliverBotToBotMessage(options, { fromRoleId, toRoleIds, body, runId,
    tenantId? })`: the fan-out gate. 1 recipient → delivers immediately
    (`getOrCreateThreadForRole` + `insertMessage` with `senderRoleId`,
    same primitives `runChatTask` already uses for the human-facing
    reply). 2+ recipients → issues a real pending approval via the
    existing `issueApproval` (already imported/used by this driver's own
    broker dependencies — no second issuance path invented) and delivers
    nothing. `capabilities.capability_id` is FK-enforced, so the
    fan-out capability (`chat.bot_fanout`) is upserted idempotently
    first, same pattern `packages/db`'s own `seedInboxTriage` uses for a
    capability with no connector manifest.
  - Kept deliberately narrow per the Description: one gate function, not
    a new orchestration layer — nothing yet *calls*
    `deliverBotToBotMessage` from a live agent tool (see gap below).

  **Known gap — explicitly out of reach of this task's `Owned_Paths`:**
  `services/control-api/src/app.ts`'s `POST /threads/:id/messages`
  handler resolves the target thread via `deps.listThreads()`, which is
  the 1:1-only accessor (TASK-125's `createGroupThread`/
  `listAllThreadsWithMembers` are a *separate* pair of accessors) — so
  posting a human message into a real group thread's ID 404s today.
  `app.ts`/`ports.ts` are not in this task's `Owned_Paths` (control-api
  is entirely absent from the list), so I could not fix the lookup there.
  I judged silently shipping a compose box that 404s on send worse than
  disabling it, so `ChatShell.tsx` disables `ComposeBox` for a group
  thread (existing, generic `disabled` prop — no `ComposeBox.tsx` edit).
  Same reasoning: no live agent tool yet calls the new
  `deliverBotToBotMessage` gate from within a running chat task — that
  wiring point (an actual "message another bot" tool a running agent can
  invoke) doesn't exist anywhere in the codebase yet, and inventing one
  from scratch is exactly the "general multi-agent orchestration" the
  Description says this task does not need to solve. The gate itself is
  real, tested against real Postgres, and mutation-proof (see evidence).
  This mirrors TASK-123/124's own honest, documented-gap pattern rather
  than a silent partial delivery.

  **Tests added:**
  - `GroupThreadDialog.test.tsx` (new, owned): renders-nothing-when-closed,
    client-side 2+ validation, happy path (asserts the real
    `POST /threads/group` body), server-error path, 401 path, cancel.
  - `chatRunDriver.test.ts`: new `integration` describe,
    "deliverBotToBotMessage — fan-out approval rule (TASK-122)", real
    Postgres (own role/task/run fixtures, FK-ordered cleanup in
    `afterAll`): (1) single recipient delivers immediately with a real
    `sender_role_id`-attributed message and zero pending approvals; (2)
    2-recipient fan-out produces a real pending `approvals` row
    (capability `chat.bot_fanout`) and delivers to neither recipient; (3)
    empty-recipient-list rejects before touching the database.
    **Mutation-proof, verified directly**: temporarily replaced the
    `toRoleIds.length > 1` guard with `false`, reran — test (2) failed
    exactly as expected (`expected true to be false`, i.e. it delivered
    immediately with no approval), confirming the check is live, not
    inert (ADR-005). Reverted before committing (diff confirmed clean).

## Test_Evidence

- `pnpm --filter @oikonomos/dashboard test`: 17 files / 75 tests passed
  (existing suites unmodified except this task's additions; no other
  file in `components/chat/**` outside `Owned_Paths` was touched).
- `pnpm --filter @oikonomos/worker exec vitest run src/chatRunDriver.test.ts`:
  8 tests passed (5 pre-existing TASK-116 tests skipped without
  `DATABASE_URL`... with `DATABASE_URL` set, all 8 run: 2 real-SDK TASK-116
  tests + 3 new TASK-122 fan-out tests, all passing against real Postgres).
- Mutation-proof check (see Work Log): guard-disabled rerun reddened the
  fan-out test as expected; reverted.
- `pnpm -r build`: 17/17 projects clean.
- `pnpm lint`: clean, zero warnings.
- `pnpm -r test` (full recursive, per CLAUDE.md's amended review standard):
  ran twice. Both runs: every package green except one lone flake in
  `services/worker`'s `src/registerCapabilities.test.ts` (`registerCapabilities
  PostgreSQL idempotency > leaves the complete declaration inventory
  byte-identical on a second registration`) — a pre-existing Postgres-
  concurrency-sensitive test unrelated to this task's diff (its query
  filters `adapter IN ('mcp:gmail', 'mcp:google-calendar',
  'mcp:google-drive', 'sdk:builtin')`; this task's capability uses
  `adapter: 'chat:bot_fanout'`, outside that filter). Isolated re-run
  (`pnpm --filter @oikonomos/worker test` alone, twice) both green,
  41/41 (+1 skipped without... no, DATABASE_URL was set, so 41 passed +
  1 skipped is the non-DB-dependent unit test in the same file, not a
  DB-gated skip) — confirms an environment-contention flake under full
  concurrent recursive load, not a regression from this diff. Same
  standing practice PLAN.md's orchestrator_notes already documents for
  this exact class of flake.

## Artifacts

apps/dashboard/src/components/chat/ChatShell.tsx,
apps/dashboard/src/components/chat/BotSidebar.tsx,
apps/dashboard/src/components/chat/ConversationPane.tsx,
apps/dashboard/src/components/chat/GroupThreadDialog.tsx,
apps/dashboard/src/components/chat/GroupThreadDialog.test.tsx,
apps/dashboard/src/pages/ChatPage.tsx,
apps/dashboard/src/lib/api.ts,
services/worker/src/chatRunDriver.ts,
services/worker/src/chatRunDriver.test.ts,
dossiers/TASK-122.md
