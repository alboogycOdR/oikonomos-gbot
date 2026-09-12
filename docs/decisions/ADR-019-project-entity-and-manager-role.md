# ADR-019 — Project is a thin first-class entity over group threads; a manager bot is a Project role with governed `project.*` capabilities; bot creation and grants by a bot are declared-but-disabled

**Status:** Proposed (Fable 5.1 design session, 2026-09-12; implementing tasks on `packages/broker/**` require adversarial review by a model other than their author)
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

v1 managers work only among roles a human provisioned and placed on the roster. The approval boundary the brief asked for is designed by **declaring** `project.create_role` (T4_irreversible) and `project.request_grant` (T3_external) in the built-in tool table with `enabled: false`, exactly as `gmail.yaml` declares `email.send` disabled. Consequences today: `CapabilityRegistry` will not mount them, L1 denies `capability.disabled`, and a test asserts no path from a manager turn writes `roles` or `role_grants`. Consequences when a later ADR enables them: they are already on the parking side of the tier map (T3/T4), and a `require_approval_rules` row for the manager role makes the human the approver of every bot creation and every grant — the boundary ADR-010 §6 implies but never named. Declaring them now costs two rows and buys a stable place for the decision; doing it later under feature pressure is how ungoverned paths get built.

### 5. Spend is bounded on two independent axes, and fan-out is capped

- **Per project:** `projects.budget_usd`; every run started from the project's thread or from a `task.assigned` handoff is attributed via a new `spend_records.project_id`; the broker's pure `budgetGate` gains `budget.project_exceeded`.
- **Per role:** `roles.budget_usd` (NULL = none) with `budget.role_exceeded`. The manager gets a tight one; its own turns are charged to it; specialists' runs are charged to the specialists and the project, never to the manager.
- **Fan-out:** at most `roster size` `task.assigned` handoffs per manager turn, enforced in the tool and audited; simultaneous execution is bounded by the Workspace-1 concurrency gate (TASK-238).

The platform ceiling and per-routine budgets are unchanged and still evaluated first. A manager cannot raise any budget.

### 6. DEVDEPARTMENT informs the data shapes; nothing from it is reused

PLAN.md task block → `project_tasks`; Owned_Paths → artifact ownership; `needs_review` → `review`; Review_Findings → `project_decisions`; "verify claims, do not trust Test_Evidence" → `task.completed` must carry artifacts the manager re-reads. No code, hook, script or command from `scripts/`, `hooks/` or `.claude/` is exposed to or reused by the product.

## Consequences

- New: six tables plus two columns; four handoff kinds; eight declared built-in tools (two disabled); two budget-gate inputs; project routes; a manager charter; board/register views on the Workspace-1 Work and Results views.
- Protected-path work: `packages/broker/src/builtinTools.ts` and `budgetGate.ts` — adversarial, different-model review.
- Unchanged: ADR-010's enforced set; ADR-012's locator-only handoff rule; ADR-013's two authorities; `GROUP_MEMBER_CAP = 6`; the single-owner routing rule.
- Sequencing: after Wave Workspace-1's TASK-237/238/242/243/244/246 where files overlap (`app.ts`, `ports.ts`, `chatRunDriver.ts`, the Work view).
- Open for a later ADR: enabling `project.create_role` / `project.request_grant` (with the `require_approval_rules` row as a precondition), cross-project artifact sharing, and a Project template (a Project recipe is a Templates v2 question).
