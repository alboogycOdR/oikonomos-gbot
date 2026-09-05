# TASK-174 — Wire a visible sign-out button to LoginScreen.signOut

## Work Log

- [2026-09-05T22:20:00Z] [S5] Session start. Read AGENTS.md, PLAN.md TASK-174
  block (fresh claim, no Review_Findings — not a rework). Worktree's local
  PLAN.md was stale (still showed TASK-173 as `claimed`), which made
  `hooks/territory-firewall.js` block edits to `roster_screen.dart` as
  cross-territory (it computed active tasks including the stale TASK-173).
  Fixed by `git reset --hard mainco/master` on the freshly-created,
  commit-less `task/TASK-174-s5` branch to pick up the real PLAN.md (TASK-173
  `done`, TASK-174 `claimed`) before making any edits — no code changes lost,
  branch had zero commits at that point.
- [2026-09-05T22:20:00Z] [S5] Read `login_screen.dart` in full per the task
  description before touching `roster_screen.dart`. Key facts used:
  - `LoginScreen.signOut(apiClient, authPort)` is already real: clears the
    session cookie (`apiClient.clearSession()`) then calls
    `authPort.signOut()` (real Firebase sign-out + Google account cache
    clear in `FirebaseGoogleAuthPort`).
  - `LoginScreen`'s real default port (`_DefaultAuthPort`) is private to
    `login_screen.dart` and out of this task's `Owned_Paths` — there is no
    way to thread the *same instance* `LoginScreen` used to sign in through
    to `RosterScreen` without touching a file this task doesn't own.
  - Decision (stated honestly per the task description): `RosterScreen`
    gets its own optional `authPort` parameter (nullable, for test
    injection) and lazily constructs a **fresh** default
    `FirebaseGoogleAuthPort()` when none is supplied. This is safe because
    both `signIn` and `signOut` ultimately operate on the same underlying
    `GoogleSignIn.instance` / `FirebaseAuth.instance` singletons — a second
    port instance still signs out of the one real session. Documented this
    reasoning inline on the new `authPort` field's doc comment.
- [2026-09-05T22:20:00Z] [S5] Implementation in `roster_screen.dart`:
  - Added `authPort` field + `_resolvedAuthPort()` helper (lazy shared
    default, mirroring `LoginScreen`'s own `_DefaultAuthPort` indirection
    pattern so a real `FirebaseGoogleAuthPort` is never eagerly constructed
    by a `const` default).
  - Added a `sign-out-button` `IconButton` (logout icon) to the AppBar
    actions, alongside the existing `new-bot-button`.
  - Added `_signOut()`: calls `LoginScreen.signOut(...)`, then
    `Navigator.pushAndRemoveUntil` to a fresh `LoginScreen` with
    `(route) => false` — clears the entire nav stack so the back button
    cannot return to a roster whose session was just cleared.
- [2026-09-05T22:20:00Z] [S5] Tests in `roster_screen_test.dart`: added a
  local `_FakeGoogleAuthPort` (the existing `FakeGoogleAuthPort` in
  `login_screen_test.dart` is under TASK-173's `Owned_Paths`, not this
  task's, so it wasn't reused/imported — a fresh local fake was the correct
  in-territory choice). New test: tap `sign-out-button` →
  `authPort.signOutCallCount == 1`, `client.isAuthenticated == false`
  (real, code-level confirmation that `apiClient.clearSession()` ran — this
  is the honest substitute for "shows the real account picker on next
  sign-in", since the real Google SDK/account-picker cache can't be
  exercised in a widget test at all), navigates to `LoginScreen`, and the
  resulting `Navigator` reports `canPop() == false` (stack cleared).
- [2026-09-05T22:20:00Z] [S5] Test evidence: `flutter analyze` → "No issues
  found!". `flutter test test/screens/roster_screen_test.dart` → 11/11
  passed (10 pre-existing + 1 new). Full `flutter test` (apps/mobile) →
  102/102 passed, no regressions. Nothing touched outside
  `apps/mobile/lib/screens/roster_screen.dart` and
  `apps/mobile/test/screens/roster_screen_test.dart` (this task's
  `Owned_Paths`) plus this dossier.
- Status: needs_review.
