# ADR-019 — Project is a thin first-class entity over group threads; a manager bot is a Project role with governed `project.*` capabilities; bot creation and grants by a bot are declared-but-disabled

**Status:** Accepted (2026-09-12, after adversarial review by CX9 / Codex GPT — accept-with-changes, all three required changes applied below; see `ADR-019-review-cx9-2026-09.md` for the full verdict). Implementing tasks on `packages/broker/**` require adversarial review by a model other than their author.
**Date:** 2026-09-12
**Author:** Fable 5.1, from `docs/research/fable-brief-templates-project-manager-bot-2026-09-12.md`
**Related:** `specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md` (the spec this decides for); ADR-010 §6 (enforced set and the "autonomous by default, tightenable by rule" tier); ADR-012 (typed handoffs carry locators, never values); ADR-013 (declaration-verified registry); `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` (uses group threads as the interim container); CLAUDE.md budget rule.

## Context

Group threads (TASK-120), single-owner routing with a six-member cap (TASK-180/189), typed async handoffs (ADR-012, TASK-090/099/131) and the runtime `tasks`/`runs` model are all real. What is missing is any shared state for multi-bot work beyond message history: no board, no register of what was produced, no log of what was decided, no status. The brief asked whether a "Project" and a "manager/coordinator bot" are two features, and whether a coordinator may create bots or grant capabilities.

Facts from the code that constrain this:

- Governance actions are not approval-gated today: `POST /roles`, `POST /roles/:id/grants` and routine creation execute immediately behind the session cookie, and there is no `capability_id` for "create a role" or "grant a capability", so no `require_approval_rules` row could target them. ADR-010 §6 lists neither in the enforced set nor in the tightenable set; they are simply out of its scope.
- The runtime `tasks` table is an execution unit (one chat turn or one routine fire), not a work item. It has no assignee beyond `role_id`, no state beyond the run lifecycle, no parent.
- `profile_facts.project_id` exists (`005_agent_memory.up.sql`) with no table to reference; project-scope memory is a vocabulary without a referent.
- Budget dimensions are per-routine, per-provider and platform-wide. There is no per-role budget and nothing that could attribute a specialist's run to a coordinating context.
- ORCH's DEVDEPARTMENT layer is the platform's own development orchestration (PLAN.md, hooks, review). It is the strongest working example of the outer-loop pattern this project has, and it is entirely inappropriate to expose as product code.

## Decision

### 1. One primitive, not two

A **Project** is the shared workspace. A **manager** is a role of a Project: `project_roles.is_manager = true` plus grants on the `project.*` capabilities. Everything a manager reads or writes — roster, board, artifacts, decisions, status — is Project state that the human sees and edits through the same API. A Project with no manager is valid and useful; the manager is optional automation over the same state. Designing them separately would have produced two task systems and two places to put "blocked".

### 2. A thin new entity, bound to exactly one group thread

`projects` (goal, done criterion, status, budget) with `thread_id UNIQUE` referencing the existing group thread, plus three tables that have no existing home: `project_tasks` (work items with owner, state, mandatory blocked reason), `project_artifacts` (a register of references — D1 workspace paths under the project's directory, attachment ids, run ids — with sha256 and provenance, never bytes), `project_decisions` (approvals by reference, human and manager decisions, review findings). Roster stays `thread_members`, extended by `project_roles` for the manager flag and responsibility text. `profile_facts.project_id` finally references something.

A composed view was rejected because the board, register and log are new state; a parallel messaging or task system was rejected because the thread, the handoff mailbox and the run model already work and are governed. Runtime `tasks` are linked from work items through `project_task_runs`; the two tables are never merged.

### 3. Handoffs stay the transport, with new typed kinds that carry locators only

`handoffKinds` gains `task.assigned`, `task.completed`, `task.blocked`, `status.requested`. They carry `{project_id, task_id, artifact_ids[]}` under the existing CHECK that forbids a `value` key. A handoff still carries no privilege (F8/R13); a `task.completed` must reference a registered artifact or receipt, which the receiver re-reads live. This is the brief's "handoff quality is a file format problem" made mechanical.

### 4. The manager routes; it does not create bots or grants — and the capabilities for doing so are declared now, disabled

v1 managers work only among roles a human provisioned and placed on the roster. The approval boundary the brief asked for is designed by **declaring** `project.create_role` (T4_irreversible) and `project.request_grant` (T3_external) in the built-in tool table with `enabled: false`, exactly as `gmail.yaml` declares `email.send` disabled. Consequences when a later ADR enables them: they are already on the parking side of the tier map (T3/T4), and a `require_approval_rules` row for the manager role makes the human the approver of every bot creation and every grant — the boundary ADR-010 §6 implies but never named. Declaring them now costs two rows and buys a stable place for the decision; doing it later under feature pressure is how ungoverned paths get built.

Two invariants make "disabled" and "cannot create or grant" true by construction rather than by mounting behaviour (review changes 1 and 2; the review showed that at `6f2c57e` `CapabilityRegistry.build` checks tier and adapter drift but not enabled-state drift, and `brokerPorts.getCapability` resolves any declared tool whose *persisted* row is enabled, so a declared-disabled tool with a stale enabled row and a grant would pass L1 — the earlier claim "L1 denies `capability.disabled`" was not true as written):

**Invariant A — declared-disabled is enforced at registry build and at L1, independently of persistence.** `CapabilityRegistry.build` rejects **enabled-state drift** (a declaration with `enabled: false` whose persisted row is `enabled = true`, or vice versa) with a new `CapabilityEnabledDriftError`, alongside C5's tier/adapter drift. `brokerPorts.getCapability` returns `null` for any declaration with `enabled: false` regardless of the persisted row, and `decidePreToolUse` reports it with a **new, per-capability** deny reason `capability.declared_disabled` — distinct from `capability.disabled`, which keeps its current meaning of the global kill switch. Tests: construction throws on drift; direct L1 call with a granted role is denied `capability.declared_disabled`; the tool is absent from every mount. This is a `packages/broker` change and ships as its own protected-path task before any `project.*` tool exists.

**Invariant B — the manager mount contains no role-creation or grant route.** The project MCP server exposes exactly the enabled `project.*` tools in §7.2 and nothing else; its handlers call `packages/db` project functions only and never `createRole`, `upsertRoleGrant`, or any control-api route. A **liveness test through the real broker→MCP composition** (not the present workspace bridge) invokes every mounted manager tool in turn and asserts, by row counts taken before and after, that `roles` and `role_grants` are unchanged. The test is keyed on evidence (the audit events each tool emits) so it fails if the mount is silently swapped.

### 5. Spend is bounded on two independent axes, and fan-out is capped

- **Per project:** `projects.budget_usd`; every run started from the project's thread or from a `task.assigned` handoff is attributed via a new `spend_records.project_id`; the broker's pure `budgetGate` gains `budget.project_exceeded`.
- **Per role:** `roles.budget_usd` (NULL = none) with `budget.role_exceeded`. The manager gets a tight one; its own turns are charged to it; specialists' runs are charged to the specialists and the project, never to the manager.
- **Fan-out:** at most `roster size` `task.assigned` handoffs per manager turn, enforced in the tool and audited; simultaneous execution is bounded by the Workspace-1 concurrency gate (TASK-238).

The platform ceiling and per-routine budgets are unchanged and still evaluated first. A manager cannot raise any budget.

**Atomic admission (review change 3).** Today's `budgetGate` is pure and consumes figures read serially before spawn, with a documented TOCTOU (`subprocessProviders.ts:109-122`); adding two more independently-read axes would widen that window. The project and role axes are therefore admitted through a **reservation protocol**, not a read-then-spawn check:

1. A `spend_reservations` table (`reservation_id`, `tenant_id`, `axis` ∈ {`project`,`role`}, `axis_id`, `run_id`, `reserved_usd`, `created_at`, `released_at NULL`) and per-axis ledger rows in `budget_ledgers` (`axis`, `axis_id`, `month`) that exist only to be locked.
2. Admission is one transaction: `SELECT … FOR UPDATE` the ledger rows for the run's project and role; compute `recorded spend + open reservations` per axis; if either would exceed its ceiling with this run's reservation added, roll back and deny (`budget.project_exceeded` / `budget.role_exceeded`); otherwise insert the reservation (sized at the provider's documented per-turn maximum, the same ceiling TASK-220 uses for the Gemini lane) and commit — all before provider spawn.
3. When spend is recorded, the reservation is released in the same transaction as the `spend_records` insert; when a run fails before any spend, `noteFailureUnrecordedSpend`'s path releases it. Release happens exactly once (`released_at` guard).
4. Test: two simultaneous near-limit admissions on the same axis result in at most one provider invocation; the second is denied before spawn. Repeated for the project axis and the role axis.

This preserves the existing gate's semantics for the platform, provider and routine axes (their TOCTOU is neither widened nor fixed here — fixing it is a separate, smaller change that can adopt the same ledger) and makes the two new axes genuinely independent ceilings.

### 6. DEVDEPARTMENT informs the data shapes; nothing from it is reused

PLAN.md task block → `project_tasks`; Owned_Paths → artifact ownership; `needs_review` → `review`; Review_Findings → `project_decisions`; "verify claims, do not trust Test_Evidence" → `task.completed` must carry artifacts the manager re-reads. No code, hook, script or command from `scripts/`, `hooks/` or `.claude/` is exposed to or reused by the product.

## Resolution — all three required changes applied 2026-09-12

- Change 1 (manager mount invariant + real-composition liveness test) → §4 Invariant B; spec §7.3 and §11 updated.
- Change 2 (declared-disabled as registry-build and L1 invariant with its own deny reason) → §4 Invariant A; a new protected-path broker task precedes any `project.*` tool; spec §7.3 and §10 (P-0) updated.
- Change 3 (atomic budget reservation) → §5 "Atomic admission"; spec §6 and §10 (P-3) updated.

## Consequences

- New: six tables plus two columns, plus `spend_reservations` and `budget_ledgers`; four handoff kinds; eight declared built-in tools (two disabled); two budget axes admitted by reservation; `CapabilityEnabledDriftError` and deny reason `capability.declared_disabled` in the broker; project routes; a manager charter; board/register views on the Workspace-1 Work and Results views.
- Protected-path work: `packages/broker/src/capabilityRegistry.ts`, `index.ts` (deny reason), `builtinTools.ts` and `budgetGate.ts` — adversarial, different-model review on each.
- Unchanged: ADR-010's enforced set; ADR-012's locator-only handoff rule; ADR-013's two authorities; `GROUP_MEMBER_CAP = 6`; the single-owner routing rule.
- Sequencing: after Wave Workspace-1's TASK-237/238/242/243/244/246 where files overlap (`app.ts`, `ports.ts`, `chatRunDriver.ts`, the Work view).
- Open for a later ADR: enabling `project.create_role` / `project.request_grant` (with the `require_approval_rules` row as a precondition), cross-project artifact sharing, and a Project template (a Project recipe is a Templates v2 question).
