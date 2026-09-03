# TASK-108 — wire ChatShell to live API + routing (Chat-1d)

## Work Log

- [2026-09-03T13:10:00Z] [S5] Session start. control.mode=strict — dispatcher
  pre-claimed TASK-108; skipped PLAN.md scanning/claiming entirely. Found a
  stale `.devteam/CHECKPOINT.md` from an earlier compaction pointing at
  TASK-107 (still `claimed` at that point); re-read PLAN.md fresh from disk
  per protocol and confirmed the real current state: TASK-107 is `done`
  (merged by ORCH at 3b275f3 on the integration branch, `master`), TASK-108
  is `claimed`/`S5` with an empty Progress_Notes/Branch not yet created.
  Deleted the stale checkpoint's relevance by treating PLAN.md as truth per
  protocol (did not touch PLAN.md itself, per strict mode).

  Worktree was still on `task/TASK-107-s5` locally, one commit behind the
  merged integration branch (main checkout at `E:/DELL-PROJECTS/GROKBOT-
  CLONE` is on `master`, up to date, includes the TASK-107 merge plus
  subsequent ORCH/TASK-106/TASK-111 activity). Added the main checkout as a
  git remote (`mainco`) inside the worktree, fetched it, and created
  `task/TASK-108-s5` reset to `mainco/master` (c523b3c) rather than off my
  stale local `task/TASK-107-s5` tip — the latter predates several merges
  (TASK-106 control-api endpoints, TASK-111 territory work) I need.

  Preflight (`python scripts/preflight_paths.py TASK-108`):
  ```
  [preflight] TASK-108 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   apps/dashboard/src/App.tsx  -> exists, 80 line(s), 2267 bytes
    GLOB   apps/dashboard/src/pages/**  -> 8 file(s): ApprovalInboxPage.{tsx,test.tsx},
             EvidenceBrowserPage.{tsx,test.tsx}, LoginPage.tsx, RunDetailPage.{tsx,test.tsx},
             RunListPage.tsx
    GLOB   apps/dashboard/src/lib/**  -> 4 file(s): AuthContext.tsx, api.ts,
             registerServiceWorker.{ts,test.ts}
    FILE   apps/dashboard/src/main.tsx  -> exists, 21 line(s), 526 bytes
  ```

  Read spec §4/§5, TASK-106's real `services/control-api/src/app.ts`
  handlers for `/roles`, `/threads`, `/threads/:id/messages` (both verbs) to
  get the exact wire shapes (camelCase throughout except the approval
  sub-object, which the server literally spreads as `action_render` —
  documented in `lib/api.ts`'s `ThreadMessage` type so Chat-1e doesn't have
  to rediscover it), and TASK-107's `components/chat/{ChatShell,types,
  BotSidebar,ComposeBox}.tsx` for the props contract I'm wiring into
  (`components/chat/**` not modified — confirmed by `git diff --stat`
  before committing).

  **Implementation:**
  - `lib/api.ts` (+`Role`/`Thread`/`ThreadMessage` types, `listRoles`,
    `listThreads`, `listThreadMessages`, `sendThreadMessage`) — additive,
    reuses the existing `request()` wrapper/`UnauthorizedError` pattern
    unchanged (spec: "reuse lib/api.ts's existing auth/session handling
    as-is").
  - `pages/ChatPage.tsx` (new) — loads real threads on mount (thread.id
    doubles as `<ChatShell>`'s `botId`, matching v1's one-thread-per-bot
    model), maps server shapes to `components/chat/types.ts`'s
    `BotSummary`/`ChatMessage` in one place. `members`/`routines` passed as
    `[]` — no `GET /role_routines` endpoint exists yet (out of Chat-1d's
    endpoint set per spec §4); leaving those two RightPanel tabs empty
    rather than wiring against something that doesn't exist.
  - Polling: `POST` sets `isBotResponding=true` and records the sent
    message's `createdAt`; a `setInterval` (only mounted while
    `isBotResponding`) re-fetches the transcript every 2s and clears itself
    (`return () => clearInterval(...)` from the effect) the moment a `role
    === "bot"` message newer than the pending send is observed, or the
    active thread changes. No poll ever starts on idle load — only right
    after this tab sends a message. AC3 covered directly: `ChatPage.test.tsx`
    spies `window.clearInterval` and asserts it fires once the reply lands.
  - `App.tsx`: `/` → `<ChatPage>`; `/ops/{runs,runs/:runId,approvals,
    evidence,evidence/:runId}` are the real routes now; the old bare paths
    (`/runs`, `/runs/:runId`, `/approvals`, `/evidence`, `/evidence/:runId`)
    become `<Navigate replace>` redirects to their `/ops/*` counterpart
    rather than being deleted — this was a deliberate choice to avoid
    touching `App.test.tsx`, which is **not** in this task's `Owned_Paths`
    (only the bare file `apps/dashboard/src/App.tsx` is listed, not a glob
    covering its co-located test) and still asserts against `/runs`
    directly. Verified the redirect chain doesn't change either test's
    observable behavior (unauth → still lands on `/login`; post-login →
    `RequireAuth`'s captured `from` state still routes to `/ops/runs`
    exactly as before) — `App.test.tsx` passes unmodified.
  - `pages/LoginPage.tsx`: default post-login landing changed from
    `/runs` to `/` (the new primary surface) for the no-deep-link case;
    `from` (captured by `RequireAuth`) still takes priority when present,
    so this doesn't change `App.test.tsx`'s outcome either — this file
    *is* in `Owned_Paths` (`pages/**`).
  - `pages/ChatPage.test.tsx` (new): three ACs directly asserted —
    (1) real threads from `GET /threads` render, fixture-only names never
    leak; (2) `POST /threads/:id/messages` fires on send, the transcript
    updates via poll, the bot reply renders without a page reload;
    (3) `clearInterval` is observed to fire once the reply lands (not
    merely "no more fetches happened", which would be flakier evidence of
    the same claim).

  **Test evidence:**
  - `pnpm --filter dashboard test -- --run`: 14 files, 46/46 green
    (2 new `ChatPage.test.tsx` cases + all 44 pre-existing, including
    unmodified `App.test.tsx`).
  - `pnpm -r build`: 17/17 packages green (`apps/dashboard` `tsc && vite
    build` clean, 257 kB / 81 kB gzip bundle, no type errors from the new
    `lib/api.ts` exports or `ChatPage.tsx`).
  - `pnpm lint`: clean, zero findings.
  - `pnpm -r test` (full recursive suite per CLAUDE.md's amended review
    standard, not just `apps/dashboard`): all workspace packages green —
    `packages/db`, `packages/approvals`, `packages/broker`,
    `packages/harness-factory`, `services/control-api` (110/110, including
    TASK-106's own `chat.routes.test.ts` 7/7 and `no-raw-sql.test.ts`
    14/14), `services/worker`, `services/gateway-telegram`, `evals/*`, all
    passed. No `intakeNonces` flake surfaced this run (TASK-107's dossier
    noted that pattern previously; not reproduced here, ran clean).

  **AC status against spec:**
  - AC1 (real threads at `/`, not fixture data): met — `ChatPage.test.tsx`
    asserts fixture bot names never appear once real data loads.
  - AC2 (send → task created, bot reply appears once TASK-111's driver
    runs): **send → task creation is fully wired and tested** (`POST
    /threads/:id/messages` call verified). **Bot-reply-appearing is
    verified only against a mocked poll response in this task's own test**,
    not against a live TASK-111 run — per this task's Description, TASK-111
    was explicitly relaxed as a build/test dependency but is still needed
    for ORCH to verify this criterion end-to-end for real. Checked PLAN.md:
    TASK-111 (CX) shows `Status: blocked` as of the commit at
    `c523b3c chore(plan): CONTROL TASK-111: CX -> blocked` — **so TASK-111
    is not merged/live as of this session.** Flagging this plainly per the
    task's own instruction: AC2's "bot's reply appearing" needs a final
    live check from ORCH once TASK-111 lands; everything up to task
    creation is done and tested now.
  - AC3 (polling stops on terminal/no-run-in-flight, tested via interval
    clearing): met — `ChatPage.test.tsx`'s `clearInterval` spy assertion.
  - AC4 (`/ops/*` regression — same behavior as pre-task `/runs` etc.):
    met — `App.test.tsx` (unmodified, outside Owned_Paths) still exercises
    the exact same auth-redirect and login-then-list flow end to end,
    now via one extra client-side redirect hop through `/ops/runs`.
  - AC5 (`pnpm -r test`/`build`/`lint` all exit 0): met, see evidence above.

  **Next step / handoff:** none — this task's own scope (build+unit-test
  against TASK-106's real API) is complete and green. Ready for
  `needs_review`, with the AC2 live-verification caveat called out above
  for ORCH's final check once TASK-111 is live.
