# TASK-357 dossier

**Brief:** Mobile: bot-to-bot entries and "Messaged X" previews in the roster.

Render TASK-356's bot_pair entries in the roster (overlapping pair avatar, 'BotA and BotB'); tapping opens a read-only transcript that reuses the existing message rendering, with no composer. bot_outbound previews get a leading arrow icon. Older servers render as today.

**Assigned:** CX9. **Depends on:** TASK-356, TASK-355.

**Spec pointers:** specs/OIKONOMOS_CHAT_SURFACE_v1.0.md section 8; TASK-356 API

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-25T11:11:00Z] [CX9] Preflight passed: `apps/mobile/lib/screens/roster_screen.dart`, `apps/mobile/lib/api/models.dart`, and `apps/mobile/test/screens/roster_screen_test.dart` all exist. Implemented explicit `bot_pair` model detection, overlapping roster avatars, a read-only handoff transcript, and the outbound preview icon. Focused roster test (24/24) and `flutter analyze lib` pass; full mobile suite next.
- [2026-09-25T11:12:07Z] [CX9] Full verification complete: `flutter analyze lib` reports no issues and foreground `flutter test` exits 0. TASK-357 widget coverage verifies pair rendering, read-only transcript (no composer), outbound icon, and older-server group fallback. Dart is outside the pnpm recursive workspace, so no pnpm command applies.
