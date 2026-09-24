# TASK-355 dossier

**Brief:** Mobile: handoff chips inline in the chat timeline.

Handoff chips render today in a separate horizontal list above the messages. Place each chip in the timeline at its handoff's time, among the bubbles, as a compact 'N messages with {bot}' chip, grouping consecutive handoffs with the same bot. Keep the tap behaviour and remove the separate list.

**Assigned:** CX9. **Depends on:** TASK-353.

**Spec pointers:** memory: grok-bot-mobile-reference item 1 ("2 messages with TREVOR" inline in a bot's own timeline); apps/mobile/lib/screens/chat_screen.dart ~L773-791

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log
