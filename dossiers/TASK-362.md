# TASK-362 dossier

**Brief:** Mobile and web: show "Not configured" for connectors in Connectors & tools.

Use TASK-361's `configured` field. In the mobile Connectors & tools screen and the web BotToolsPanel, a system with configured=false shows a 'Not configured' badge and its capability switches are disabled with the reason 'Ask the workspace owner to configure this connector'; configured=true shows normally; 'unknown' or absent renders as today (no badge). Parse defensively so an older server without the field still works. The wording says 'configured', never 'connected', because it is an operator setting, not a user link.

**Assigned:** CX9. **Depends on:** TASK-361.

**Spec pointers:** TASK-361 API; TASK-353 (mobile screen) and TASK-354 (web panel) both had the not-connected state descoped; memory: grok-bot-mobile-reference (Plugins page)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master (`git branch --show-current` should be task/TASK-362-cx9). Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Every review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`).

## Work Log
