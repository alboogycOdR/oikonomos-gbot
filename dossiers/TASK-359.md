# TASK-359 dossier

**Brief:** Group rooms cannot run away: per-turn bot message and round caps.

A group room can loop bot replies triggered by bot replies, bounded only by spend. Add two caps per user message in a group thread: OIK_GROUP_MAX_BOT_MESSAGES (default 8) and OIK_GROUP_MAX_ROUNDS (default 3 rounds of bot-reacting-to-bot). These are ORCH defaults, not spec numbers; the owner may tune them. On a cap: stop fanout, post ONE visible system message ('Paused: the bots have said a lot. Reply to continue.') and audit the category group.cap_reached. A new user message resets. Keep the existing consecutive_bot_cap and quiet_room behaviour.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_REMAINING_WORK_2026-09-16.md (Bot-to-bot & group: runaway protection); groupRouting.ts GROUP_MEMBER_CAP; TASK-328 hop cap covers handoffs only

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-25T00:00:00Z] [CX9] Preflight completed:
  ```text
  [preflight] TASK-359 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/worker/src/groupRouting.ts  -> exists, 159 line(s), 6441 bytes
    FILE   services/worker/src/groupRouting.test.ts  -> exists, 94 line(s), 3865 bytes
    FILE   services/worker/src/groupFanout.ts  -> exists, 107 line(s), 4770 bytes
    FILE   services/worker/src/groupFanout.test.ts  -> exists, 140 line(s), 6192 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-25T00:00:00Z] [CX9] Blocked before code changes: `services/control-api/src/ports.ts` owns the only live group-thread routing path (`routeGroupMessage`) and existing `evaluateGroupRoomLimits` enforcement. It has the `threadId`, reads the group transcript, returns stop reasons, and can post the required visible system notice/audit. The owned worker `deliverBotToBotMessage` instead accepts only role IDs and writes separate 1:1 recipient threads; it has neither a group thread ID nor a stable per-user-message/round identity, so it cannot implement or test the requested per-group-thread caps, reset, visible notice, or audit event. Expanding worker-only interfaces would be disconnected from the live path. Required territory expansion: `services/control-api/src/ports.ts` and its relevant route/integration tests (or a separately assigned integration task).
