# TASK-363 dossier

**Brief:** Workforce checker: a zero-inference watch that catches runaway group and handoff activity.

The spec pattern is 'a bot whose job is catching group chatter and loops'. Build it as a DETERMINISTIC worker check with NO model call (an LLM bot would spend the budget it is meant to protect). Every 10 minutes (reuse the worker's existing poll or job mechanism; do not add a new scheduler) run runWorkforceCheck(options, now): count, per tenant and over the last 60 minutes, the audit events group.cap_reached, role_message.depth_capped, role_message.duplicate and terminal role-message delivery failures, plus the number of messages per group thread. When any threshold is exceeded (defaults: 3 cap or depth events, 20 duplicates or 10 delivery failures, 60 messages in one room, all overridable by OIK_WORKFORCE_* env vars; these are ORCH defaults, not spec numbers) insert ONE system message authored as 'Workforce checker' into the affected group thread, or for role-level events into the owner's own thread, naming what was seen and the count, and write a workforce.alert audit event (category and counts only). Send at most one alert per source per hour. Add the audit-query function you need next to the existing audit functions (a count-by-type over a time window), tenant-scoped.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_REMAINING_WORK_2026-09-16.md (Bot-to-bot & group interaction: "Workforce checker bot pattern"); DISPOSITION row 18; TASK-359 (group caps) and TASK-328 (depth cap) emit the events it reads; owner cost concern 2026-09-25 (R350/month ceiling)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master (`git branch --show-current` should be task/TASK-363-cx9). Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Every review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`).

## Work Log

- [2026-09-25T21:05:00Z] [CX9] Pre-flight completed:
  ```text
  [preflight] TASK-363 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    services/worker/src/workforceChecker.ts  -> does not exist; parent services/worker/src/ exists
    NEW    services/worker/src/workforceChecker.test.ts  -> does not exist; parent services/worker/src/ exists
    FILE   services/worker/src/main.ts  -> exists, 285 line(s), 15139 bytes
    FILE   packages/db/src/auditEvents.ts  -> exists, 300 line(s), 9988 bytes
    FILE   packages/db/src/auditEvents.test.ts  -> exists, 45 line(s), 2460 bytes
    FILE   packages/db/src/index.ts  -> exists, 369 line(s), 8553 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-25T21:06:00Z] [CX9] Blocked before implementation: `services/control-api/src/ports.ts:922-928` writes `group.cap_reached` with payload `{ reason }` and no `threadId`; `audit_events` likewise has no thread column. TASK-363 requires posting to the affected group thread, which cannot be derived reliably from the event. Adding `thread_id` (or equivalent) to this producer is outside TASK-363 Owned_Paths. Please widen territory to `services/control-api/src/ports.ts` (and its tests) or provide an approved source-to-thread mapping.
- [2026-09-25T22:35:00Z] [CX9] Implemented the deterministic workforce checker after the approved scope widening. `group.cap_reached` now records its real `threadId`; the tenant-scoped DB aggregation covers cap/depth/duplicate events, terminal role-message deliveries, and group message volumes. Alerts are system notices prefixed “Workforce checker”, carry only category/count in `workforce.alert`, and are deduplicated per source for one hour. `main.ts` runs it immediately and then every ten minutes through the existing maintenance poll. Added real-Postgres threshold, tenant-isolation, hourly-guard, no-provider, and worker-wiring liveness coverage. Verification: `scripts/test-isolated.ps1 -Init -Filter @oikonomos/worker` then `scripts/test-isolated.ps1 -Filter @oikonomos/worker` passed the worker suite including TASK-363 (the existing sandbox-reaper `SECRET_UNSET` console diagnostics remained non-failing); `scripts/test-isolated.ps1 -Filter @oikonomos/control-api` passed; `pnpm typecheck` and `pnpm build` exited 0.
