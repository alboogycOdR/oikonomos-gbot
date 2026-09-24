# TASK-352 dossier

**Brief:** Mobile: Auto-review toggle and Review rules screen in bot settings.

Replace the static 'Auto-review' heading in the bot settings sheet (chat_screen.dart ~L1407) with a real switch bound to GET/PUT /roles/:id/auto-review, worded 'Require approval for risky shell, MCP, and computer actions'. Below it, an 'Auto-review rules' row opens review_rules_screen.dart: it lists the bot's rules (auto-created ones marked), adds a rule for one of the bot's capabilities, and removes one. A failed toggle reverts the switch with a SnackBar.

**Assigned:** CX9. **Depends on:** TASK-348, TASK-350.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-350 API; memory: grok-bot-mobile-reference (Auto-review toggle, "Auto-review Rules" sub-page)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log
