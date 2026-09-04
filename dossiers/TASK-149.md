# TASK-149 — Mobile Wave 2b: push-notification client integration (env-gated FCM)

Unit: S5. Branch: `task/TASK-149-s5` (branched from `master` at
`6f92bd6 chore(plan): claim TASK-149 [SV origin=S5]`, which already includes
TASK-145's push backend and TASK-148's approval-cards/routines/settings
merge). control.mode=strict — this dossier is the only coordination record;
PLAN.md is never touched.

## Pre-flight (Owned_Paths check, pasted verbatim)

```
[preflight] TASK-149 Owned_Paths inspected in E:/DELL-PROJECTS/GROKBOT-CLONE
[preflight] 1 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   apps/mobile/**  -> 21 file(s):
           apps/mobile/analysis_options.yaml
           apps/mobile/lib/api/api_client.dart
           apps/mobile/lib/api/exceptions.dart
           apps/mobile/lib/api/models.dart
           apps/mobile/lib/main.dart
           apps/mobile/lib/realtime/sse_client.dart
           apps/mobile/lib/screens/chat_screen.dart
           apps/mobile/lib/screens/create_bot_screen.dart
           apps/mobile/lib/screens/login_screen.dart
           apps/mobile/lib/screens/roster_screen.dart
           apps/mobile/lib/widgets/avatar.dart
           apps/mobile/pubspec.lock
           ... and 9 more
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

Everything I touched or created is under `apps/mobile/**`. No writes outside
`Owned_Paths` or this dossier.

## Design

Read `services/control-api/src/ports.ts` (`notifyAfterChatRun`) and
`services/control-api/src/pushTransport.ts` (`FcmHttpPushTransport.send`) to
confirm the wire contract this client consumes: `POST /devices` takes
`{token, platform}` (`packages/db/src/deviceTokens.ts`'s
`devicePlatforms = ["android", "ios", "web"]`), and every push is a
**data-only** FCM message (`{type: "approval-pending"|"run-completed", runId}`,
never a `notification` block) — meaning a foreground `onMessage` listener is
the only path, regardless of OS notification-permission state.

New files (all `apps/mobile/**`):
- `lib/push/push_port.dart` — `PushPort` abstraction: `getToken()`,
  `onTokenRefresh`, `onForegroundMessage`, `dispose()`.
- `lib/push/noop_push_port.dart` — dormant fallback (config absent).
- `lib/push/firebase_push_port.dart` — real `firebase_messaging`-backed
  implementation. Only ever constructed after `Firebase.initializeApp()`
  succeeds; no test exercises it directly (untestable without a real SDK —
  every behavior it delegates to is covered against the `PushPort`
  interface via a fake instead, per the task's testability requirement).
- `lib/push/push_message.dart` — `PushMessage`/`PushMessageType`, decodes
  the FCM `data` map; unrecognized `type` or missing `runId` decodes to
  `null` (forward-compatible, never crashes).
- `lib/push/device_platform.dart` — maps `defaultTargetPlatform`/`kIsWeb`
  onto the exact `android`/`ios`/`web` wire values.
- `lib/push/push_registrar.dart` — `PushRegistrar`: obtains the initial
  token, registers via `ApiClient.registerDevice`, re-registers on
  `onTokenRefresh`, forwards foreground messages to a caller-supplied
  callback. Registration failures are swallowed (reported via an optional
  `onRegistrationError` callback) — push is additive, never load-bearing,
  and must never crash the app. The token is never logged anywhere in this
  path.

Modified:
- `lib/api/api_client.dart` — added `registerDevice(token, platform)`
  (`POST /devices`, session-cookie authenticated like every other call).
- `lib/main.dart` — the config gate: `try { await Firebase.initializeApp(); ... } catch (_) { NoopPushPort }`.
  No config file exists (and none may be committed), so this always falls
  through to `NoopPushPort` today; the same code path lights up the real
  port with zero further change once a real config file is added later.
- `lib/screens/login_screen.dart` — threads an optional `pushPort` param
  (default `NoopPushPort`, so every prior test of this screen is
  unaffected) through to `RosterScreen` on successful login.
- `lib/screens/roster_screen.dart` — `RosterScreen` now takes an optional
  `pushPort` (same default), builds a `PushRegistrar` in `initState`,
  disposes it in `dispose()`, and shows a `SnackBar` (keyed
  `push-notification-snackbar`) for a decoded foreground message.
- `pubspec.yaml`/`pubspec.lock` — added `firebase_core` + `firebase_messaging`
  (`flutter pub add`, network available in this environment).

Test doubles: `test/support/fake_push_port.dart` (`FakePushPort`, scriptable
token/rotation/message streams, no platform channel involved).

## Acceptance criteria — verified

- [x] Absent Firebase config → app boots/behaves identically to TASK-148's
  state — `roster_screen_test.dart`'s "with the default (dormant) push
  port..." test asserts exactly 2 requests total (login + GET /threads),
  i.e. no `/devices` call ever fires.
- [x] Token obtained → registered via `POST /devices` with the session
  cookie; rotation re-registers — `push_registrar_test.dart`'s "an initial
  token registers..." and "a token rotation re-registers..." tests, plus
  `api_client_test.dart`'s two new `registerDevice` tests (success body,
  409/400 → `ApiException`).
- [x] Foreground notification path renders for both trigger types —
  `roster_screen_test.dart`'s "a foreground approval-pending message..."
  and "a foreground run-completed message..." widget tests (SnackBar,
  keyed and by exact copy).
- [x] No Firebase credential/config file committed (`git status` — only
  the 8 new `lib/push/**` + `test/push/**` + `test/support/fake_push_port.dart`
  files and edits to existing files listed below; no `google-services.json`
  / `GoogleService-Info.plist` anywhere); no full device token ever logged
  (grep confirms no `print`/`log` call touches a token anywhere in
  `lib/push/**` or `lib/api/api_client.dart`'s new method).
- [x] `flutter analyze` + `flutter test` exit 0.

## Test evidence

```
cd apps/mobile && flutter analyze
Analyzing mobile...
No issues found! (ran in 4.4s)

cd apps/mobile && flutter test
...
00:05 +59: All tests passed!
```
(59 tests total, up from 52 before this task; all pre-existing tests still
pass unmodified in behavior — only two call sites gained an optional,
defaulted `pushPort` parameter.)

## Work log

- [2026-09-05T00:00:00Z] [S5] Branched `task/TASK-149-s5` off `master`
  (confirmed it — not the stale `mainco/master` — carries TASK-145 and
  TASK-148's merges). Read TASK-145's device-registry/push-transport
  contract and TASK-148's app state. Implemented the `PushPort`
  abstraction, `NoopPushPort`/`FirebasePushPort`, `PushRegistrar`,
  `PushMessage` decoding, `ApiClient.registerDevice`, wired the config
  gate into `main.dart`, and threaded `pushPort` through
  `LoginScreen`/`RosterScreen` with a SnackBar for foreground messages.
  Added `firebase_core`/`firebase_messaging` via `flutter pub add`. Wrote
  unit tests for the registrar/message decoding and widget tests for the
  dormant-default and foreground-notification paths, plus `ApiClient`
  tests for `registerDevice`. `flutter analyze` clean, `flutter test`
  59/59. Committed to the task branch. Handing off `needs_review`.
