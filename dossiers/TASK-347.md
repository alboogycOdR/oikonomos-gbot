# TASK-347 dossier

**Brief:** Bots keep the avatar colour and shape chosen at creation (backend).

Today the avatar picked at bot creation is a preview only: POST /roles takes no avatar field and the avatar is derived from roleId (apps/mobile/lib/screens/create_bot_screen.dart:16-26). Add roles.avatar_color and roles.avatar_shape (migration 037, both nullable; null keeps today's derived avatar). Define ONE closed palette of 12 colour tokens and 8 shape tokens (e.g. circle, square, rounded, hexagon, diamond, star, triangle, teardrop), validated in packages/db and exported so clients can mirror it. POST /roles and PATCH /roles/:roleId accept optional avatarColor/avatarShape; serializeRole and GET /threads return them. Tokens, not hex, so clients own rendering.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05) row 1 (upload deferred, colour/shape in scope); owner decision 2026-09-24: save it, full 12 colours x 8 shapes

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log
