# TASK-334 dossier

**Brief:** Mobile: unread badges and pinning in the roster

**Assigned:** S5. **Depends on:** TASK-332, TASK-333.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T15:10:00Z] [CX9] Preflight completed before implementation:
  ```text
  [preflight] TASK-334 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   apps/mobile/lib/api/models.dart  -> exists, 873 line(s), 26791 bytes
    FILE   apps/mobile/lib/api/api_client.dart  -> exists, 833 line(s), 31542 bytes
    FILE   apps/mobile/lib/screens/roster_screen.dart  -> exists, 305 line(s), 10468 bytes
    FILE   apps/mobile/lib/screens/chat_screen.dart  -> exists, 1552 line(s), 53810 bytes
    FILE   apps/mobile/test/screens/roster_screen_test.dart  -> exists, 516 line(s), 17678 bytes
    FILE   apps/mobile/test/screens/chat_screen_test.dart  -> exists, 1626 line(s), 55890 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-24T15:10:00Z] [CX9] Implemented TASK-333 mobile integration: defensive unread/pin parsing, API methods for mark-read/pin/unpin (including DELETE transport), unread badge, pinned-first roster sorting, long-press toggle with roster reload, and best-effort post-transcript mark-read from the normal roster chat entry path. Added widget tests for badge, pin/unpin, ordering, successful mark-read and failure-not-blocking navigation.
- [2026-09-24T15:10:00Z] [CX9] Verification passed: `flutter test test/screens/roster_screen_test.dart test/screens/chat_screen_test.dart` — 64/64 tests; `flutter analyze lib/api/models.dart lib/api/api_client.dart lib/screens/roster_screen.dart lib/screens/chat_screen.dart` — no issues; `git diff --check` — clean. Dart/Flutter is outside pnpm -r.
- [2026-09-24T17:54:41Z] [CX9] Addressed batch-review REWORK findings: roster reloads after a chat route pops, so a successfully read thread no longer retains a stale unread badge; pinned rows now show a pin indicator. Added widget assertions for the returned-chat badge refresh and the visible pin state. Verification: `flutter test test/screens/roster_screen_test.dart test/screens/chat_screen_test.dart` — 65/65 passed; `flutter analyze lib` — no issues; full `flutter test` — passed; `git diff --check` — clean. Dart/Flutter is outside pnpm -r.
