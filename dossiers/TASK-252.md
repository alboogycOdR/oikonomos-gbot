# TASK-252 — Adversarial review of ADR-018 and ADR-019 (non-Anthropic model)

**Unit:** CX9 · **Priority:** medium · **Depends_On:** —

## Brief
See PLAN.md TASK-252 Description: two review files, ADR-015 review format, pressure points answered with file:line evidence, no edits to the ADRs.

## Work Log

- [2026-09-12T13:05:00Z] [CX9] Created the two owned adversarial reviews against commit `6f2c57e12627bd47b2c3579be3d87766699035e5`. ADR-018 requires a broader credential/split-field policy and resolution of the zero-grant-write contradiction. ADR-019 requires end-to-end manager write-proof, declared-disabled L1 enforcement, and atomic multi-axis budget admission. `git diff --check` passed; repository has no Prettier executable (`pnpm exec prettier --check ...` failed with command not found).
- [2026-09-12T13:07:00Z] [CX9] STOPPING BLOCKED: `git commit -m "docs: add adversarial ADR reviews [TASK-252]"` was rejected by the mandatory `territory-precommit` hook. It classifies both exact TASK-252 Owned_Paths as hard-prohibited protected paths even though PLAN.md explicitly assigned these two review files. Review artifacts remain uncommitted in the task worktree; no bypass attempted. Supervisor must reconcile the hook exception for adversarial review artifacts or commit the reviewed files through an authorised protected-path mechanism.
