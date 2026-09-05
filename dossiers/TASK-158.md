# TASK-158 — Mobile routine creation UI

## Work Log

- [2026-09-05] [S5] Session start. Read AGENTS.md, S5_BUILD_BRIEFING.md
  (control.mode=strict), PLAN.md TASK-158 block (Review_Findings empty —
  fresh task, no rework). No existing dossier. Worktree's local PLAN.md was
  stale (missing TASK-158 entirely) — fast-forwarded from `mainco/master`
  before doing anything else, since the territory firewall reads that file
  to authorize writes and initially blocked with "no active task".
  `task/TASK-158-s5` did not exist as a real branch locally; `git checkout -b`
  created it per the dispatch instructions (a `mainco/task/TASK-158-s5` ref
  existed remotely but was identical to base — no prior work to resume).

- Investigated TASK-148's existing routines tab
  (`apps/mobile/lib/screens/chat_screen.dart` — `_buildRoutines`,
  `_loadRoutines`, `Routine` model, `ApiClient.listRoutines`) per the task's
  explicit instruction to extend, not replace, it. Confirmed the real
  server route shape by reading `services/control-api/src/app.ts` directly
  (not inferring from the spec prose): `POST /roles/:roleId/routines`,
  `CREATE_ROUTINE_SCHEMA` requires `name`+`schedule` (non-empty strings),
  `definition` optional object; `nextFireAtFromCron` throws (→ 400) on an
  invalid cron string, caught by the route handler and sent as
  `{error: message}` — the exact shape `ApiClient._throwForError` already
  turns into `ApiException(message)` for every other write call, so no new
  error-parsing logic was needed on the client. Confirmed
  `definition.goal` is the field `services/worker/src/jobs/routineJob.ts`
  reads as the created task's instruction (grepped the job file directly).

- Followed `CreateBotScreen`'s established pattern (dedicated pushed
  screen, `pop(true)`/`pop(false)`/`pop()` convention, client-side
  validation before any request, inline error `Text` keyed for tests)
  rather than a dialog, to stay consistent with the one other creation flow
  already in this app.

- **Scoping choice (per the task's own note):** schedule is a plain
  cron-expression text field, not a friendlier "weekdays at 8:00 AM"
  picker — the task explicitly calls the picker a "separable follow-up,
  not required here." A `helperText` on the field says "Standard 5-field
  cron" so the user isn't left guessing the format.

## Implementation

- `apps/mobile/lib/api/api_client.dart`: added
  `createRoutine(roleId, name, schedule, {goal})` — `POST
  /roles/:roleId/routines`. Builds `definition: {goal: trimmedGoal}` only
  when a non-empty, trimmed goal is given; omits the `definition` key
  entirely otherwise (never sends `{goal: ""}`).
- `apps/mobile/lib/screens/create_routine_screen.dart` (new): form screen
  with `routine-name-field`, `routine-schedule-field` (required),
  `routine-goal-field` (optional), `create-routine-submit` button.
  Client-side blocks empty name/schedule before firing any request.
  Catches `ApiException` and shows the server's message via
  `create-routine-error`; catches `UnauthorizedError` and pops like every
  other authenticated screen; generic fallback message on anything else.
  Pops `true` on success.
- `apps/mobile/lib/screens/chat_screen.dart`: added a `create-routine-fab`
  FloatingActionButton, visible only on the Routines tab (tracked via the
  existing `_onTabChanged` listener, now also triggering a `setState` so
  the FAB's visibility follows the active tab). Pushes
  `CreateRoutineScreen`; on a `true` result, force-refreshes the routines
  list (`_loadRoutines(force: true)` — added a `force` parameter to the
  existing memoized loader) so the new routine appears without leaving and
  re-entering the screen, per the acceptance criterion.

## Test Evidence

`C:\tool\flutter\bin\flutter analyze` — **No issues found!** (apps/mobile)

`C:\tool\flutter\bin\flutter test` (full apps/mobile suite) — **All tests
passed! (70/70)**, including:
- `test/api/api_client_test.dart`: 3 new `createRoutine` cases — sends
  `definition.goal` only when a goal is given (asserts exact request body
  via `jsonDecode`), omits `definition` entirely when no goal, surfaces a
  server 400 validation error as `ApiException` with the server's message.
- `test/screens/create_routine_screen_test.dart` (new): blocks submission
  on empty name (no request fires — asserted via `fake.requests` length),
  blocks on empty schedule, surfaces a server validation error visibly and
  stays on-screen (no pop) on failure, omits the goal field when left
  empty and pops `true` on success.
- `test/screens/chat_screen_test.dart`: new case — tapping the FAB opens
  the create screen, submitting a valid name+schedule fires the real POST,
  and on success the routines tab shows the new routine without the test
  ever popping back out and re-entering the screen (asserts empty-state
  key disappears and the new routine's name appears in the same screen
  instance).

Acceptance criteria, all verified by the tests above:
- [x] Real `POST /roles/:roleId/routines` fires with the exact body shape
- [x] Server-side validation error surfaces as a visible error
- [x] Successful creation reflected in the routines tab without re-entry
- [x] Empty name or empty schedule prevented client-side
- [x] `flutter analyze` and `flutter test` exit 0; nothing outside
      `apps/mobile/**` touched (confirmed via `git status`/`git diff
      --stat` before commit — only `apps/mobile/**` files plus this
      dossier)

## Status

`needs_review`. Handoff to ORCH — no known open issues. Branch
`task/TASK-158-s5`, commit `4c01071` (`feat(mobile): add routine creation
flow to routines tab [TASK-158]`).
