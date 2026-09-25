# TASK-354 dossier

**Brief:** Web: Auto-review toggle, review rules and Connectors & tools in the bot panel.

Web parity for TASK-352/353 in the bot's right panel: the Auto-review switch (same wording), a review rules panel (list, add, remove), and a Connectors & tools panel (grouped capabilities, grant switch, locked and not-connected states), following existing panel/API patterns.

**Assigned:** CX9. **Depends on:** TASK-349, TASK-351.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05); TASK-350 and TASK-351 APIs

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-25T06:50:00Z] [CX9] Started on `task/TASK-354-cx9`. Preflight output:
  ```text
  [preflight] TASK-354 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 9 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   apps/dashboard/src/components/chat/RightPanel.tsx  -> exists, 222 line(s), 8353 bytes
    FILE   apps/dashboard/src/components/chat/RightPanel.test.tsx  -> exists, 159 line(s), 5322 bytes
    NEW    apps/dashboard/src/components/chat/BotToolsPanel.tsx  -> does not exist; parent apps/dashboard/src/components/chat/ exists
    NEW    apps/dashboard/src/components/chat/BotToolsPanel.test.tsx  -> does not exist; parent apps/dashboard/src/components/chat/ exists
    NEW    apps/dashboard/src/components/chat/ReviewRulesPanel.tsx  -> does not exist; parent apps/dashboard/src/components/chat/ exists
    NEW    apps/dashboard/src/components/chat/ReviewRulesPanel.test.tsx  -> does not exist; parent apps/dashboard/src/components/chat/ exists
    FILE   apps/dashboard/src/components/chat/types.ts  -> exists, 70 line(s), 2465 bytes
    FILE   apps/dashboard/src/lib/api.ts  -> exists, 691 line(s), 23687 bytes
    FILE   apps/dashboard/src/lib/api.test.ts  -> exists, 67 line(s), 3524 bytes
  ```

- [2026-09-25T06:53:27Z] [CX9] Added a Tools tab in the web bot panel: server-confirmed Auto-review switch, review-rule list/add/remove controls limited to granted capabilities, and connector-grouped tool grant switches with locked state. Added dashboard API helpers and focused component/API tests. Verification: `powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1 -Filter @oikonomos/dashboard` — 27 files / 171 tests passed (React `act()` warnings in pre-existing App tests only); `pnpm build` — exit 0; `pnpm typecheck` — exit 0; `powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1 -Init` — exit 0; foreground `powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1` — exit 0, dashboard 27 files / 171 tests passed and no suite failures.
