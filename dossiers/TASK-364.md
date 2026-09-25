# TASK-364 dossier

**Brief:** Model routing: a pure function that picks the cheap provider for background work.

Today resolveRoleRuntime (packages/db/src/roles.ts) returns the role's provider or OIK_DEFAULT_ROLE_PROVIDER, and a routine run uses it (routineJob.ts ~L204). Add a PURE function routeModel({ kind, budgetRemainingUsd, budgetCeilingUsd, roleProvider, roleModel, defaults, cheap }) -> { provider, model, reason } with no I/O (unit-testable). Rules, in order: (1) an explicit role provider or model always wins (reason 'override'); (2) a background routine run (never a user chat turn) whose role sets no provider uses the configured cheap provider, OIK_BACKGROUND_PROVIDER and OIK_BACKGROUND_MODEL, when set (reason 'background'); (3) when remaining budget is below 20% of the ceiling, background work uses the cheap provider even if a default exists (reason 'budget_low'); (4) otherwise the default (reason 'default'). Wire it into routine runs ONLY; do not change chat turns, group routing, or chatRunDriver.ts. With none of the new env vars set, behaviour is byte-identical to today. Record the routing reason in the run's audit event payload (category only). The 20% threshold is an ORCH default the owner may tune.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_REMAINING_WORK_2026-09-16.md (Model routing & cost: pure-function Tier-0 model routing with explicit inputs: routine kind, budget remaining, override, default); CLAUDE.md Budget (hard ceiling R350/month)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master (`git branch --show-current` should be task/TASK-364-cx9). Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Every review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`).

## Work Log
