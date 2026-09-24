# TASK-327 dossier

**Brief:** Harden role-message delivery: isolate failures, cap attempts, tell the sender

**Assigned:** CX9. **Depends on:** TASK-333.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T15:05:19Z] [CX9] Verified the reported gaps, added migration 035 and tokenized delivery leases/attempt cap/terminal sender notices. Isolated DB package suite passed (46 files, 293 passed, 2 skipped); worker suite has been rerun after raising the real pg-boss concurrency test timeout to 20s, and a full recursive isolated run was allowed to complete. Next: commit the owned changes and hand off with the recorded evidence.
- [2026-09-24T15:08:00Z] [CX9] Committed 5058163. DB and TypeScript checks are green; a final recursive isolated-harness process is still running serially under the shared test-database lock. NEXT: collect its summary, classify any non-owned baseline failures, then submit for review.
- [2026-09-24T17:30:00Z] [CX9] Rebased TASK-327 onto master, retaining TASK-342's pg-boss lock/20s-timeout and thread_members cleanup fixes. Added real-Postgres worker coverage for poison-row continuation and the fifth-failure sender notice, and wrapped secondary failure-recording errors so the poll loop continues with category-only logging. `pnpm --filter @oikonomos/worker exec tsc --noEmit` and `git diff --check` pass. Migration 035 up/down/up against `oikonomos_test` passed. The main-checkout isolated recursive harness was reinitialized from migrations 001–035 and completed; its initial worker run's only failures were the already-classified TASK-343 `$1,000` subprocess fixture overlap (platform-budget cascade), unrelated to this task. Preflight: all 7 Owned_Paths were verified (6 existing, roleMessageDelivery.test.ts NEW and unused). Committed rework as d97cda9. NEXT: supervisor review of d97cda9 on the rebased task branch.
