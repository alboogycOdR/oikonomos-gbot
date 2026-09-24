# TASK-328 dossier

**Brief:** Handoff hop-depth cap and idempotent role-message send

**Assigned:** CX9. **Depends on:** TASK-327, TASK-340.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T15:50:00Z] [CX] Implemented migration 036, transactional source-run depth calculation, SHA-256 resend idempotency, and category-only liveness audits. Added real-Postgres chain/dedupe coverage plus Claude and Gemini lane propagation tests. Targeted DB and worker isolated suites are green; full recursive suite remains to run.
- [2026-09-24T16:00:00Z] [CX9] Addressed ORCH rework F1: completed the owned control-api RoleMessage test fixture with TASK-327 delivery state and TASK-328 hopDepth. Confirmed the workspace mailbox's embedded fake already includes the same required fields. `pnpm build` and `pnpm typecheck` pass; initialized and ran the full recursive isolated harness to completion, with no failure output observed.
