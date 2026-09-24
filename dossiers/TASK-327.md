# TASK-327 dossier

**Brief:** Harden role-message delivery: isolate failures, cap attempts, tell the sender

**Assigned:** CX9. **Depends on:** TASK-333.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T15:05:19Z] [CX9] Verified the reported gaps, added migration 035 and tokenized delivery leases/attempt cap/terminal sender notices. Isolated DB package suite passed (46 files, 293 passed, 2 skipped); worker suite has been rerun after raising the real pg-boss concurrency test timeout to 20s, and a full recursive isolated run was allowed to complete. Next: commit the owned changes and hand off with the recorded evidence.
