# TASK-359 dossier

**Brief:** Group rooms cannot run away: per-turn bot message and round caps.

A group room can loop bot replies triggered by bot replies, bounded only by spend. Add two caps per user message in a group thread: OIK_GROUP_MAX_BOT_MESSAGES (default 8) and OIK_GROUP_MAX_ROUNDS (default 3 rounds of bot-reacting-to-bot). These are ORCH defaults, not spec numbers; the owner may tune them. On a cap: stop fanout, post ONE visible system message ('Paused: the bots have said a lot. Reply to continue.') and audit the category group.cap_reached. A new user message resets. Keep the existing consecutive_bot_cap and quiet_room behaviour.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_REMAINING_WORK_2026-09-16.md (Bot-to-bot & group: runaway protection); groupRouting.ts GROUP_MEMBER_CAP; TASK-328 hop cap covers handoffs only

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log
