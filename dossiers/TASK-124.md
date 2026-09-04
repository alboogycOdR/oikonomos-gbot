# TASK-124 — Wire activeRoleId into RightPanel through the live chat UI (Grants-1e)

## Work Log

- [2026-09-04T08:00:00Z] [S5] Session start. Stale session-start hook/checkpoint referenced
  TASK-119 (already reviewed, merged by ORCH per PLAN.md — commit b7386cc "TASK-119 approved
  first-pass, merged, opened TASK-124 fast-follow"); dispatch prompt is authoritative and
  correctly names TASK-124. Re-read AGENTS.md, PLAN.md TASK-124 block, and
  briefings/S5_BUILD_BRIEFING.md (strict mode). Fetched mainco/master, created branch
  `task/TASK-124-s5` from it (worktree was still on the old, now-merged `task/TASK-119-s5`).

  Preflight (`python scripts/preflight_paths.py TASK-124`):
  ```
  [preflight] TASK-124 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   apps/dashboard/src/components/chat/ChatShell.tsx  -> exists, 77 line(s), 2438 bytes
    FILE   apps/dashboard/src/components/chat/ChatShell.test.tsx  -> exists, 167 line(s), 5154 bytes
    FILE   apps/dashboard/src/pages/ChatPage.tsx  -> exists, 229 line(s), 7895 bytes
    FILE   apps/dashboard/src/pages/ChatPage.test.tsx  -> exists, 230 line(s), 8700 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

  Investigation: `ChatShell.tsx` already derives `activeBot` from its own `activeBotId` state
  (set via `useState`, updated by `handleSelectBot`) — exactly the "state it already tracks the
  active bot" the task description points at. `activeBot` carries `roleId` because
  `BotSummary.roleId` already exists (types.ts) and `ChatPage.tsx`'s `toBotSummary` already sets
  `roleId: thread.roleId` (pre-existing, not something this task added). So the only real gap was
  `ChatShell.tsx` not passing `activeBot?.roleId` to `<RightPanel activeRoleId=...>` — `ChatPage.tsx`
  itself needed no code change, only new regression-test coverage per the acceptance criteria
  (its Owned_Paths inclusion was for the test file).

  Implemented: `ChatShell.tsx` now passes `activeRoleId={activeBot?.roleId}` to `RightPanel` —
  no parallel state added, reuses the existing `activeBot` derivation.

  Added tests:
  - `ChatShell.test.tsx`: new `describe("activeRoleId wiring to RightPanel (TASK-124)")` block —
    (1) permissions section shows real grants for the initially active bot; (2) switching bots
    via the sidebar updates which bot's grants are shown (asserts both appearance of the new
    bot's grant and disappearance of the old one).
  - `ChatPage.test.tsx`: new test asserting the full `ChatPage -> ChatShell -> RightPanel` chain
    surfaces the Permissions section and a real fetched grant, not just RightPanel in isolation.

  Found and fixed a real latent bug surfaced by this wiring: the existing "threads real approval
  grant data through to Always Allow" test in `ChatPage.test.tsx` mocked
  `GET/POST /roles/role-1/grants` as a single `url.endsWith` branch returning the POST-create
  response (`{}`, 201) regardless of method. Once `activeRoleId` genuinely reaches `RightPanel`,
  it now also GETs that same URL on mount to populate the list, and `grants.map` threw on the
  non-array body. Fixed by splitting the mock on `init?.method === "POST"` vs GET. This was a
  pre-existing test gap (the mock never had to distinguish the two before), not a code defect.

  **Test evidence:**
  - `pnpm --filter @oikonomos/dashboard test` — 16 files, 69/69 pass (incl. 3 new TASK-124 tests:
    2 in ChatShell.test.tsx, 1 in ChatPage.test.tsx).
  - `pnpm -r build` — 17/17 packages clean.
  - `pnpm lint` — clean, zero warnings.
  - `pnpm -r test` (full recursive, per CLAUDE.md DEVDEPARTMENT amendment) — exit 0, zero
    failures across all 18 workspace packages (broker, policy, approvals, harness-factory, db,
    control-api, worker, gateway-telegram, workspace, evals/golden, evals/harness, dashboard,
    etc.).

  All 4 acceptance criteria met and checked off (see below). Committed to `task/TASK-124-s5`
  (fc5ec5a). Handing off `needs_review`.

## Acceptance Criteria (self-check before handoff)

- [x] Permissions view visible with real grants when selected in live ChatShell/ChatPage tree
      (not just RightPanel in isolation) — new tests in both files.
- [x] Switching bots updates which bot's grants show — ChatShell.test.tsx switch test.
- [x] Existing ChatShell/ChatPage tests pass unmodified except this task's additions (one
      pre-existing ChatPage.test.tsx mock needed a method-aware fix, documented above — genuine
      latent gap the wiring exposed, not scope creep).
- [x] `pnpm -r test`, `pnpm -r build`, `pnpm lint` all exit 0.
