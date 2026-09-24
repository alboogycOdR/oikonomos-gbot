# TASK-349 dossier

**Brief:** Web: avatar colour and shape picker saved and rendered.

Web CreateBotDialog gets the same 12x8 picker, sends avatarColor/avatarShape, and Avatar.tsx renders the saved colour and shape (sidebar, conversation header, group dialog). Null keeps the derived avatar. Use TASK-347's token names so mobile and web match.

**Assigned:** CX9. **Depends on:** TASK-347.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-347 palette

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log
