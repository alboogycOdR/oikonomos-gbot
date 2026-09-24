# TASK-348 dossier

**Brief:** Mobile: full 12x8 avatar picker that is saved and shown everywhere.

Replace the 6x2 preview with the full 12-colour x 8-shape picker from TASK-347's palette, send avatarColor/avatarShape on create, and render the saved avatar wherever BotAvatar is used (roster, chat header, group rows). Null fields keep the derived avatar. Parse defensively for older servers.

**Assigned:** CX9. **Depends on:** TASK-347.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-347 palette

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log
