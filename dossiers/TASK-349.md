# TASK-349 dossier

**Brief:** Web: avatar colour and shape picker saved and rendered.

Web CreateBotDialog gets the same 12x8 picker, sends avatarColor/avatarShape, and Avatar.tsx renders the saved colour and shape (sidebar, conversation header, group dialog). Null keeps the derived avatar. Use TASK-347's token names so mobile and web match.

**Assigned:** CX9. **Depends on:** TASK-347.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-347 palette

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-24T22:23:56Z] [CX9] Preflight completed: all seven declared Owned_Paths exist (CreateBotDialog.tsx/.test.tsx, Avatar.tsx/.test.tsx, types.ts, api.ts/.test.ts). Read TASK-347/348’s merged API and mobile implementation: tokens are colors `red, orange, amber, yellow, lime, green, teal, cyan, blue, indigo, violet, pink` and shapes `circle, square, rounded, hexagon, diamond, star, triangle, teardrop`. Blocked before code: persisted avatar fields must be mapped from `Thread` into `BotSummary` in `apps/dashboard/src/pages/ChatPage.tsx` and passed from `BotSummary` into `Avatar` at the sidebar, conversation header, and group-dialog call sites (`BotSidebar.tsx`, `ConversationPane.tsx`, `GroupThreadDialog.tsx`); those required rendering files are outside TASK-349 Owned_Paths. Please extend territory or arrange an integration task. No TASK-349 source changes made.
