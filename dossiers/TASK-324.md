# TASK-324 dossier

**Brief:** Mobile takeover: make Enter, Backspace and Tab work from the phone keyboard (verify first)

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21. Borrow the idea, never the code.

**Approach:** see the task Description and Acceptance_Criteria in PLAN.md. Read our own code first and verify every UNVERIFIED or REPORTED claim.

## Work Log

- [2026-09-21T11:45:00Z] [S5] FINDING: bug was REAL. Pre-fix `dispatchKey` (apps/mobile/lib/api/browser_takeover_client.dart:147-151) sent `rawKeyDown {key}` + `keyUp {key}` only: no windowsVirtualKeyCode, no code, no text. Chromium ignores editing keys without a virtual key code and Enter needs keyDown with text "\r" to submit. Only caller: screens/browser_takeover_screen.dart:178 (Enter button). typeText uses `char` events (fine).
  FIX: `_keyDescriptors` table: Enter -> keyDown+text "\r", vk 13; Backspace vk 8; Tab vk 9 (rawKeyDown), each with key/code/windowsVirtualKeyCode/nativeVirtualKeyCode; keyUp mirrors. Unknown keys unchanged. No relay/auth/session change. I did not compare the web takeover (out of territory); pinned payloads in tests (Enter, Backspace, Tab, unknown, char). The old Enter assertion (bare payload) was updated: it would fail on pre-fix code the other way, i.e. new Enter test fails on old master.
  `flutter test test/api/browser_takeover_client_test.dart`: 7 passed (Dart is outside pnpm -r).
  OWNER MANUAL VERIFY (PENDING, not done headless): on a phone, open a run needing sign-in, trigger takeover, focus a username field, type text via phone keyboard, tap Enter button -> form must submit; test Backspace deletes a char and Tab moves focus (note the app UI only exposes an Enter button; Backspace/Tab need a caller to exercise on-device).
