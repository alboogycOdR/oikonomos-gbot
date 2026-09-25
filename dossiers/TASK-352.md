# TASK-352 dossier

**Brief:** Mobile: Auto-review toggle and Review rules screen in bot settings.

Replace the static 'Auto-review' heading in the bot settings sheet (chat_screen.dart ~L1407) with a real switch bound to GET/PUT /roles/:id/auto-review, worded 'Require approval for risky shell, MCP, and computer actions'. Below it, an 'Auto-review rules' row opens review_rules_screen.dart: it lists the bot's rules (auto-created ones marked), adds a rule for one of the bot's capabilities, and removes one. A failed toggle reverts the switch with a SnackBar.

**Assigned:** CX9. **Depends on:** TASK-348, TASK-350.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-350 API; memory: grok-bot-mobile-reference (Auto-review toggle, "Auto-review Rules" sub-page)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-25T03:35:00Z] [CX9] Resumed the dispatcher-claimed task on newly created `task/TASK-352-cx9` from `master`. Review_Findings is empty. Preflight completed: `apps/mobile/lib/screens/chat_screen.dart` (1585 lines), `apps/mobile/lib/api/models.dart` (937 lines), `apps/mobile/lib/api/api_client.dart` (865 lines), and `apps/mobile/test/screens/chat_screen_test.dart` (1653 lines) exist; `apps/mobile/lib/screens/review_rules_screen.dart` and `apps/mobile/test/screens/review_rules_screen_test.dart` are new territory under existing parent directories. Next: implement the TASK-350 API models/client and settings/rules UI with widget coverage.
- [2026-09-25T04:05:00Z] [CX9] Implemented typed Auto-review/review-rule/grant client models and calls, the optimistic settings switch with failure rollback SnackBar, and the selectable Review Rules screen (auto-created labels, add, remove). Widget coverage verifies switch state/PUT/failure rollback and list/add/remove; `flutter analyze lib` passed with no issues and the full `flutter test` suite passed in the foreground. Dart is outside `pnpm -r`.
