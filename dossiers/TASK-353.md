# TASK-353 dossier

**Brief:** Mobile: Connectors & tools (Plugins) screen per bot.

Add a 'Connectors & tools' entry in bot settings that opens bot_tools_screen.dart: capabilities grouped by system from GET /roles/:id/tools, each with label, description and grant switch; non-grantable entries are locked with a short reason; a system that needs an account link shows 'Not connected'. Toggling calls the existing grant or revoke endpoints and re-fetches; a failure reverts with a message. Link to the existing Skills screen as the 'skills' part rather than duplicating it.

**Assigned:** CX9. **Depends on:** TASK-351, TASK-352.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-351 API; memory: grok-bot-mobile-reference (Plugins: "Tools and skills")

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log
