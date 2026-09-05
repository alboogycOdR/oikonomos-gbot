# TASK-173 — Real per-user auth (mobile) — Google Sign-In

## Work Log

### 2026-09-05 — S5 session

**Preflight (pasted verbatim):**
```
[preflight] TASK-173 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
[preflight] 7 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   apps/mobile/lib/screens/login_screen.dart  -> exists, 136 line(s), 4240 bytes
  FILE   apps/mobile/lib/api/api_client.dart  -> exists, 356 line(s), 13527 bytes
  FILE   apps/mobile/lib/api/models.dart  -> exists, 303 line(s), 8832 bytes
  FILE   apps/mobile/test/screens/login_screen_test.dart  -> exists, 75 line(s), 2504 bytes
  FILE   apps/mobile/test/api/api_client_test.dart  -> exists, 614 line(s), 19902 bytes
  FILE   apps/mobile/pubspec.yaml  -> exists, 33 line(s), 951 bytes
  NEW    apps/mobile/android/app/google-services.json  -> does not exist; parent apps/mobile/android/app/ exists
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```
The `google-services.json` "NEW" was expected: it's `apps/mobile/.gitignore`d (real
credential-bearing file, never committed), present in the main checkout at
`E:/DELL-PROJECTS/GROKBOT-CLONE/apps/mobile/android/app/google-services.json` but not
copied into this worktree yet. Copied it in (read-only, verified its `oauth_client`
array — `client_type: 3`'s id matches ORCH's progress-note value exactly) so the app
can actually build/link against it locally; it stays untracked/gitignored, never
staged.

**Branch/base:** worktree was stale (based on a commit before TASK-172's merge). Fast-
forwarded the branch onto `mainco/master` (`60ed319`, an ancestor-safe fast-forward —
confirmed `git merge-base --is-ancestor` first) to pick up the real `/auth/google`
route before writing anything against it.

**Investigated real APIs before writing code** (per task instruction, not guessed):
- `google_sign_in` current stable: `7.2.0`. v7 replaced `signIn()` with a singleton
  (`GoogleSignIn.instance`) requiring `initialize(serverClientId: ...)` once before
  `authenticate()`; cancellation is now `GoogleSignInException` with
  `code == GoogleSignInExceptionCode.canceled`, not a null return.
- `firebase_auth` current stable: `6.6.1`. Official Firebase Flutter federated-auth
  doc's own current example: `GoogleAuthProvider.credential(idToken: googleAuth.idToken)`
  → `FirebaseAuth.instance.signInWithCredential(credential)` → `user.getIdToken()` for
  the real, backend-verifiable Firebase ID token. Confirmed `idToken`-only is valid for
  `GoogleAuthProvider.credential` (accessToken not required).
- `serverClientId` = the Web OAuth client id (`client_type: 3`) from
  `google-services.json`, `461377597606-hl2k4bvqdvpo2qu17v7vvrk532fo1sve.apps.googleusercontent.com`
  — matches ORCH's progress note; re-confirmed against the real file rather than trusting
  the note alone.
- Read the real `/auth/google` route (`services/control-api/src/app.ts` +
  `GOOGLE_LOGIN_SCHEMA`/OpenAPI `GoogleLoginRequest`): `POST /auth/google` body
  `{idToken: string}`, 200 sets a session cookie and returns `{authenticated: true}`,
  401 + `{error: "..."}` on a rejected/expired token. Built `ApiClient.loginWithGoogle`
  against this exactly, not a guess.

**Implementation:**
- `login_screen.dart`: added `GoogleAuthPort` (abstract) + `SignInCancelledException` +
  `FirebaseGoogleAuthPort` (real impl) all in this one owned file (no new file needed —
  a separate `lib/auth/...` port file would have been outside `Owned_Paths`). Mirrors the
  existing `PushPort`/`NoopPushPort` fake-injection pattern already in this codebase so
  widget tests never touch the real SDK/platform channels.
  - `LoginScreen` now shows a single "Sign in with Google" button. Cancelled sign-in →
    silent (no error shown), matches "cancelled ≠ error". Backend rejection (401) and any
    other failure (network, SDK) → real, visible `Key('login-error')` text, never silent.
  - `LoginScreen.signOut(apiClient, authPort)` — static, real, tested: clears the client
    session (`ApiClient.clearSession`) and calls `FirebaseAuth.instance.signOut()` +
    `GoogleSignIn.instance.signOut()` so the next sign-in shows the account picker again
    (`GoogleSignIn.signOut()` semantics: clears which account is connected, requires
    re-selection — confirmed via source/docs, not disconnect() which does a heavier scope
    revocation not asked for here).
- `api_client.dart`: `loginWithGoogle(idToken)` (POST /auth/google, same
  cookie-capture/error semantics as `login`), `clearSession()` (drops the in-memory
  cookie — sessions are stateless signed tokens per `auth.ts`, so client-side drop is the
  complete, real sign-out; nothing server-side to revoke).
- `pubspec.yaml`: added `google_sign_in: ^7.2.0`, `firebase_auth: ^6.6.1`.

**Real, honest gap — sign-out has no UI entry point.** `Owned_Paths` for this task is
`login_screen.dart`/`api_client.dart`/`models.dart` + tests + pubspec + the credential
file — it does not include `roster_screen.dart` or any settings screen, and neither
exists with a sign-out affordance already (checked: `grep -rn "signOut\|sign out\|logout"
apps/mobile/lib apps/mobile/test` → no hits, before this task). So `LoginScreen.signOut`
is real and independently tested (clears session + calls the real Firebase/Google
sign-out), but nothing currently calls it from the UI — wiring a visible button belongs
on `roster_screen.dart` (or a future settings screen), which is out of this task's
territory. Flagging this honestly for ORCH rather than reaching outside `Owned_Paths`
to add one myself. **Recommend a small follow-up task** (Owned_Paths:
`roster_screen.dart` + a settings surface) to add the actual button calling
`LoginScreen.signOut`.

**Known, separate, not-yet-scoped gap (per the task's own instruction, named honestly,
not fixed here):** `ApiClient._sessionCookie` is in-memory only — every app process
restart requires signing in again, regardless of auth mechanism. Unrelated to this task;
not touched.

**Testing:**
- `flutter analyze` (apps/mobile): `No issues found!`
- `flutter test` (apps/mobile): `101 passed, 0 failed` (full suite, not just this task's
  files — confirms no cross-file regression in the same package).
- Widget-test coverage added: cancelled sign-in (no error, stays on screen), backend 401
  rejection (visible error), non-auth-related failure e.g. network (visible error), full
  success path (real POST body assertion against `/auth/google`, navigates to
  `RosterScreen`). Unit test for `LoginScreen.signOut` (session cleared + auth-port
  sign-out invoked exactly once).
- **Not yet done — real on-device manual confirmation.** The task explicitly calls for
  "a manual on-device confirmation noted in the dossier" in addition to the mockable
  widget test. I have not run this build on a real device/emulator this session (no
  device attached in this environment); the widget/unit-test evidence above is what a
  headless CI-style session can produce. Flagging this explicitly rather than fabricating
  a device-test result — a real human/device pass against the live control-api (which
  itself needs the rebuild+restart ORCH's note already flagged) is still needed before
  this is genuinely end-to-end verified.

**Territory note:** `pubspec.lock` is regenerated by `flutter pub get`/`flutter test`
whenever `pubspec.yaml` changes, but it is not listed in this task's `Owned_Paths`.
`hooks/territory-precommit.js` rejected my first commit attempt for exactly this reason
— confirmed the guard is live, not just configured. Reverted `pubspec.lock` to its
pre-session committed state before the final commit; only `pubspec.yaml` (owned) carries
the new dependency declarations. Anyone running `flutter pub get` locally regenerates a
matching lockfile automatically. If CI/build pipelines need the lockfile committed too,
that's a real `Owned_Paths` gap ORCH may want to widen for this task or a follow-up.

**Status → needs_review.** All acceptance criteria addressed except the real-device
manual pass (explicitly flagged above, not silently skipped).
