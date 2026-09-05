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
- [2026-09-05T23:05:00Z] [S5] **REWORK session.** Local worktree PLAN.md was
  stale again (plan_version 13.8, `Owned_Paths` still the pre-rework list
  without `login_screen.dart`, `Status: claimed`) — `territory-firewall.js`
  correctly blocked the first edit attempt on `login_screen.dart` as
  cross-territory. Fixed by pulling the real `PLAN.md` straight from
  `mainco/master` (`git show mainco/master:PLAN.md > PLAN.md`, 13.9, widened
  `Owned_Paths`, `Status: in_progress`, REWORK findings) rather than
  resetting the branch — this branch already has the TASK-174 feature
  commit, unlike last time.
  - Read ORCH's Review_Findings in full: `RosterScreen`'s freshly-constructed
    `FirebaseGoogleAuthPort` (via `_resolvedAuthPort()`) never calls
    `_ensureInitialized()` before `signOut()`, so `FirebaseGoogleAuthPort
    .signOut()`'s old `if (_initialized) { await
    GoogleSignIn.instance.signOut(); }` guard silently skipped the real
    Google-side sign-out on that instance, even though
    `FirebaseAuth.instance.signOut()` (unconditional) ran fine. Confirmed by
    reading the code exactly as ORCH described — did not need to
    re-diagnose.
  - **Fix 1 (primary, in `login_screen.dart`):** `FirebaseGoogleAuthPort
    .signOut()` now calls `await _ensureInitialized();` unconditionally
    before `await GoogleSignIn.instance.signOut();`, dropping the
    `_initialized` gate entirely. Safe because `GoogleSignIn.instance` is a
    true singleton — `initialize()` on any instance of the port converges on
    the same underlying SDK state, so calling it from a signOut path that
    never signed in is harmless and idempotent (mirrors the existing
    `signIn()` path's own `_ensureInitialized()` call).
  - **Fix 2 (defense in depth, in `login_screen.dart`):** `_LoginScreenState
    ._submit()`'s `RosterScreen(...)` construction now passes
    `authPort: widget.authPort` (previously omitted, so `RosterScreen`
    always fell through to its own fresh default). The common real-world
    path now reuses the actual port instance that already signed in
    (already `_ensureInitialized()`-warmed), so Fix 1 is now a safety net
    for direct/test construction rather than the only thing standing between
    sign-out and a stuck cached account.
  - No changes needed in `roster_screen.dart` or its test — ORCH's findings
    said the UI wiring/keys/nav/tests were already correct, and re-reading
    them confirms that; `RosterScreen`'s `GoogleAuthPort?` field already
    accepts whatever `LoginScreen` now passes through with no type changes.
  - Did not add a widget-level regression test for the two fixes:
    `FirebaseGoogleAuthPort` talks to the real Firebase/Google SDKs directly
    (no seam for a fake at that layer, same limitation ORCH's own findings
    and the original dossier both already named), and `login_screen_test
    .dart` — the only file that could exercise `_submit()`'s `RosterScreen`
    construction — is outside this task's `Owned_Paths` (not listed even in
    the widened rework grant, which only added `login_screen.dart` itself).
    Verified by code reading, consistent with the precedent set in the first
    pass of this same task.
  - Test evidence: `flutter analyze` → "No issues found!". Full
    `flutter test` (apps/mobile) → 102/102 passed, no regressions (includes
    the pre-existing `roster_screen_test.dart` sign-out test, still green
    since `RosterScreen`'s own contract didn't change).
  - Files touched this session: `apps/mobile/lib/screens/login_screen.dart`
    only (within the rework-widened `Owned_Paths`), plus this dossier. Local
    `PLAN.md` copy refreshed from `mainco/master` as described above (not a
    PLAN.md edit — S5 never writes PLAN.md; this is picking up ORCH's
    already-committed version to unblock the firewall hook).
  - Status: needs_review (addressing REWORK).
