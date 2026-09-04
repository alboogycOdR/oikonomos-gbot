# TASK-132 — OIK-108 wire pg-boss to actually fire real routines

## Work Log

- [2026-09-04T16:35:00Z] [CX] Started on `task/TASK-132-cx`. The dispatcher-authoritative PLAN.md grants only `services/worker/src/jobs/**` and its tests. The worktree's local PLAN.md is stale and `python scripts/preflight_paths.py TASK-132` therefore reports `TASK-132 not found`; no files were changed before checking the authoritative task block and live dependencies.

- [2026-09-04T16:40:00Z] [CX] Blocked on a required contract gap. `RoutineFirePorts.environmentIsUp(roleId)` has no corresponding environment persistence model or DB accessor: `packages/db` has roles (`active`/`hidden`/`deleted`) but no environment entity or health state. Also, `role_routines.definition` is deliberately unconstrained `Record<string, unknown>`, while `createTask` requires non-empty `title`, `goal`, and `requestedBy`; no routine-to-task payload schema or mapping exists. Need ORCH/spec direction on (1) the real source of environment health and (2) the authoritative mapping from a routine to those required task fields before a real end-to-end firing job can be implemented without inventing product semantics.
