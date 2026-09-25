# TASK-353 dossier

**Brief:** Mobile: Connectors & tools (Plugins) screen per bot.

Add a 'Connectors & tools' entry in bot settings that opens bot_tools_screen.dart: capabilities grouped by system from GET /roles/:id/tools, each with label, description and grant switch; non-grantable entries are locked with a short reason; a system that needs an account link shows 'Not connected'. Toggling calls the existing grant or revoke endpoints and re-fetches; a failure reverts with a message. Link to the existing Skills screen as the 'skills' part rather than duplicating it.

**Assigned:** CX9. **Depends on:** TASK-351, TASK-352.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-351 API; memory: grok-bot-mobile-reference (Plugins: "Tools and skills")

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log
- [2026-09-25T06:45:00Z] [CX9] Preflight passed: existing `chat_screen.dart`, `models.dart`, `api_client.dart`, and chat tests; `bot_tools_screen.dart` and its test are new owned territory. Rebased the just-created task branch onto current master because this worktree initially pointed at TASK-359; the TASK-351 catalog API is now present. Implementing typed catalog/grant client support and the per-bot screen.
- [2026-09-25T06:55:00Z] [CX9] Catalog screen, settings entry, typed client methods, and focused widget coverage are implemented. The initial focused test run is green; analyzer found one new brace-style info in the screen, now corrected before the full suite.
- [2026-09-25T07:05:00Z] [CX9] Verification complete: `flutter test` full mobile suite passed (exit 0), `flutter analyze lib` reports no issues, and `git diff --check` is clean. New widget tests cover grouped catalog rendering, grant/revoke request paths and refetch, locked controls, and mutation-failure server-state retention with a snackbar.
