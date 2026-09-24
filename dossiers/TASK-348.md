# TASK-348 dossier

**Brief:** Mobile: full 12x8 avatar picker that is saved and shown everywhere.

Replace the 6x2 preview with the full 12-colour x 8-shape picker from TASK-347's palette, send avatarColor/avatarShape on create, and render the saved avatar wherever BotAvatar is used (roster, chat header, group rows). Null fields keep the derived avatar. Parse defensively for older servers.

**Assigned:** CX9. **Depends on:** TASK-347.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-347 palette

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-24T21:12:00Z] [CX9] Preflight completed: all six declared Owned_Paths exist (`create_bot_screen.dart`, `avatar.dart`, `models.dart`, `api_client.dart`, and the two owned test files). TASK-347 is merged and exposes the required 12 color tokens and 8 shape tokens. Blocked before implementation: TASK-348 requires saved-avatar rendering in `apps/mobile/lib/screens/roster_screen.dart` and `apps/mobile/lib/screens/chat_screen.dart` (header and handoff/group rows), but those files are not in Owned_Paths. Both currently call `BotAvatar` with only `seed` and `name`, so saved color/shape cannot be rendered there without out-of-territory edits. Need ORCH to add those files (and corresponding tests) to TASK-348 ownership, or split/assign the rendering integration task.
- [2026-09-24T21:45:00Z] [CX9] Resumed after the supervisor re-carved ownership. Implemented the 12-color/8-shape persisted picker, defensive wire parsing, and saved-avatar rendering in roster, chat header, and handoff rows. Focused widget tests pass; full suite and final analyzer verification are next.
- [2026-09-24T22:03:00Z] [CX9] Verification passed: `flutter analyze lib` reported no issues and full `flutter test` passed. The create-flow widget test verifies all 12 color and 8 shape controls and asserts the selected `avatarColor`/`avatarShape` POST payload; avatar tests cover saved-token rendering plus absent/unknown-token fallback.
- [2026-09-24T21:27:31Z] [CX9] Addressed the rework finding: the roster create-flow test now scrolls its expanded picker before tapping the submit control. `flutter test test/screens/roster_screen_test.dart` passed (20/20); `flutter analyze lib` reported no issues; two full `flutter test` runs completed successfully (211 passing, 0 failing).
