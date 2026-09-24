# TASK-354 dossier

**Brief:** Web: Auto-review toggle, review rules and Connectors & tools in the bot panel.

Web parity for TASK-352/353 in the bot's right panel: the Auto-review switch (same wording), a review rules panel (list, add, remove), and a Connectors & tools panel (grouped capabilities, grant switch, locked and not-connected states), following existing panel/API patterns.

**Assigned:** CX9. **Depends on:** TASK-349, TASK-351.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-350 and TASK-351 APIs

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log
