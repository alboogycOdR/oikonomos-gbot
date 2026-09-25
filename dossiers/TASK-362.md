# TASK-362 dossier

**Brief:** Mobile and web: show "Not configured" for connectors in Connectors & tools.

Use TASK-361's `configured` field. In the mobile Connectors & tools screen and the web BotToolsPanel, a system with configured=false shows a 'Not configured' badge and its capability switches are disabled with the reason 'Ask the workspace owner to configure this connector'; configured=true shows normally; 'unknown' or absent renders as today (no badge). Parse defensively so an older server without the field still works. The wording says 'configured', never 'connected', because it is an operator setting, not a user link.

**Assigned:** CX9. **Depends on:** TASK-361.

**Spec pointers:** TASK-361 API; TASK-353 (mobile screen) and TASK-354 (web panel) both had the not-connected state descoped; memory: grok-bot-mobile-reference (Plugins page)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master (`git branch --show-current` should be task/TASK-362-cx9). Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Every review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`).

## Work Log

- [2026-09-25T19:17:41Z] [CX9] Resumed `task/TASK-362-cx9` from dispatcher claim; no REWORK findings. Preflight inspected all six owned paths as existing files: `apps/mobile/lib/screens/bot_tools_screen.dart` (138 lines), `apps/mobile/lib/api/models.dart` (1076), `apps/mobile/test/screens/bot_tools_screen_test.dart` (165), `apps/dashboard/src/components/chat/BotToolsPanel.tsx` (91), `apps/dashboard/src/components/chat/BotToolsPanel.test.tsx` (47), and `apps/dashboard/src/components/chat/types.ts` (78). Implemented literal-false-only configuration state handling and focused mobile/web tests. Targeted mobile screen tests (5/5) and `flutter analyze lib` pass; isolated dashboard suite completed successfully. Full suite/build/typecheck still pending.
- [2026-09-25T19:23:12Z] [CX9] Verification complete: full Flutter suite passed; `flutter analyze lib`, workspace lint (3 pre-existing unused-disable warnings, zero errors), `pnpm typecheck`, and `pnpm build` passed. Fresh `scripts/test-isolated.ps1 -Init -Filter @oikonomos/dashboard` passed 27 files / 178 tests. The earlier dashboard failure was a newly added assertion expecting one repeated reason; corrected to assert both disabled tools, then reran green. The earlier full isolated workspace invocation ran before that test assertion correction; no production behavior defect found.
