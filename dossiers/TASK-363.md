# TASK-363 dossier

**Brief:** Workforce checker: a zero-inference watch that catches runaway group and handoff activity.

The spec pattern is 'a bot whose job is catching group chatter and loops'. Build it as a DETERMINISTIC worker check with NO model call (an LLM bot would spend the budget it is meant to protect). Every 10 minutes (reuse the worker's existing poll or job mechanism; do not add a new scheduler) run runWorkforceCheck(options, now): count, per tenant and over the last 60 minutes, the audit events group.cap_reached, role_message.depth_capped, role_message.duplicate and terminal role-message delivery failures, plus the number of messages per group thread. When any threshold is exceeded (defaults: 3 cap or depth events, 20 duplicates or 10 delivery failures, 60 messages in one room, all overridable by OIK_WORKFORCE_* env vars; these are ORCH defaults, not spec numbers) insert ONE system message authored as 'Workforce checker' into the affected group thread, or for role-level events into the owner's own thread, naming what was seen and the count, and write a workforce.alert audit event (category and counts only). Send at most one alert per source per hour. Add the audit-query function you need next to the existing audit functions (a count-by-type over a time window), tenant-scoped.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_REMAINING_WORK_2026-09-16.md (Bot-to-bot & group interaction: "Workforce checker bot pattern"); DISPOSITION row 18; TASK-359 (group caps) and TASK-328 (depth cap) emit the events it reads; owner cost concern 2026-09-25 (R350/month ceiling)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master (`git branch --show-current` should be task/TASK-363-cx9). Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Every review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`).

## Work Log
