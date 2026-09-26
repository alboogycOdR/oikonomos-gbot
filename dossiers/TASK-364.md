# TASK-364 dossier

**Brief:** Model routing: a pure function that picks the cheap provider for background work.

Today resolveRoleRuntime (packages/db/src/roles.ts) returns the role's provider or OIK_DEFAULT_ROLE_PROVIDER, and a routine run uses it (routineJob.ts ~L204). Add a PURE function routeModel({ kind, budgetRemainingUsd, budgetCeilingUsd, roleProvider, roleModel, defaults, cheap }) -> { provider, model, reason } with no I/O (unit-testable). Rules, in order: (1) an explicit role provider or model always wins (reason 'override'); (2) a background routine run (never a user chat turn) whose role sets no provider uses the configured cheap provider, OIK_BACKGROUND_PROVIDER and OIK_BACKGROUND_MODEL, when set (reason 'background'); (3) when remaining budget is below 20% of the ceiling, background work uses the cheap provider even if a default exists (reason 'budget_low'); (4) otherwise the default (reason 'default'). Wire it into routine runs ONLY; do not change chat turns, group routing, or chatRunDriver.ts. With none of the new env vars set, behaviour is byte-identical to today. Record the routing reason in the run's audit event payload (category only). The 20% threshold is an ORCH default the owner may tune.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_REMAINING_WORK_2026-09-16.md (Model routing & cost: pure-function Tier-0 model routing with explicit inputs: routine kind, budget remaining, override, default); CLAUDE.md Budget (hard ceiling R350/month)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master (`git branch --show-current` should be task/TASK-364-cx9). Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Every review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`).

## Work Log

- [2026-09-26T14:55:00Z] [CX9] Preflight: `[preflight] TASK-364 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE`; `NEW services/worker/src/modelRouting.ts`; `NEW services/worker/src/modelRouting.test.ts`; `FILE services/worker/src/jobs/routineJob.ts (297 lines)`; `FILE services/worker/src/jobs/routineJob.test.ts (350 lines)`. Implemented pure route selection plus routine-only persistence/audit wiring. Initial checks: worker typecheck passed; modelRouting test 4/4 passed; isolated worker suite run with `-Init` completed (full final result recorded before handoff).
- [2026-09-26T14:08:00Z] [CX9] Final verification: `pnpm typecheck` and `pnpm build` completed successfully. `powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1 -Filter @oikonomos/worker` passed the worker suite, including `modelRouting.test.ts` 4/4 and the real-Postgres routine routing/audit test; expected sandbox-reaper `SECRET_UNSET` diagnostic warnings remained non-fatal. The required full foreground isolated recursive suite also completed successfully after the final change; dashboard reported 178/178 passing, with pre-existing React `act(...)` warnings only.
