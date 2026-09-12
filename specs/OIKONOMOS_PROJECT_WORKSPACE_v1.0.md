# OIKONOMOS Project Workspace v1.0 — the Project primitive and the manager-bot pattern

Written 2026-09-12 (Fable 5.1 design session from
`docs/research/fable-brief-templates-project-manager-bot-2026-09-12.md`). Hard-to-reverse
decisions live in `docs/decisions/ADR-019-project-entity-and-manager-role.md`. Line
citations are against `master` `ae122be`.

Precedence: sits alongside `OIKONOMOS_WORKSPACE_WAVE_v1.0.md` (which uses group threads as
the interim project container and reserves a formal Project for later — this is that
later) and `OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md`; overrides no ADR. Where it
touches approvals it defers to ADR-010 §6 and ADR-013 unchanged.

Dependencies: group threads with single-owner routing (TASK-120/180/189), typed handoffs
(`role_messages.handoff_kind`, ADR-012), the runtime `tasks`/`runs` model, `packages/memory`
project scope, `spend_records`, the Wave Workspace-1 summary endpoint (TASK-237) and
concurrency gate (TASK-238). Templates (`OIKONOMOS_TEMPLATES_v1.0.md`) are independent.

---

## 0. Dispositions of the brief's open questions

| Question | Disposition |
|---|---|
| Are Project and manager bot two features or one? | **One primitive.** A Project is the shared workspace; a manager is a **role of a Project** (a membership flag plus `project.*` write capabilities), not a separate system. Everything the manager needs — roster, task board, artifacts, decisions, status — is Project state. (ADR-019 §1) |
| New first-class DB entity or a composed view? | **New entity**, thin. `projects` binds exactly one group thread, and owns three tables that have no existing home: `project_tasks` (the board), `project_artifacts` (the register), `project_decisions` (the log). Roster is the thread's existing `thread_members`. Memory's existing `project_id` column binds to it. (ADR-019 §2) |
| What concretely is a "shared artifact"? | A **registered file**: a durable D1 workspace path under `/oikonomos/workspace/projects/<project_id>/…` (existing `services/workspace` paths, shared by all roles by design) plus a `project_artifacts` row carrying sha256, size, producer role, producing run, and the task it belongs to. Attachments and run receipts can also be registered by reference. Never bytes in Postgres. (§4) |
| How does the task board relate to the runtime `tasks`/`runs` model? | Different things, linked. Runtime `tasks` are execution units (one chat turn, one routine fire). `project_tasks` are **work items** with an owner, a state and a blocked reason; a work item links to zero or more runs via `project_task_runs`. Never overload the `tasks` table. (§3) |
| Does the manager create bots or grants in v1? | **No.** v1 manager routes work among roles a human already provisioned and added to the roster. `project.create_role` and `project.request_grant` are **declared as capabilities but disabled** (`enabled: false`, like `email.send` in `gmail.yaml`), at T4 and T3 respectively, so the approval boundary exists in the tier map before anything can use it. Enabling them is a later ADR plus a `require_approval_rules` row. (ADR-019 §4) |
| How is manager spend bounded separately from specialists? | Two independent ceilings: a **per-project** monthly budget (all runs attributed to the project) and a **per-role** monthly budget (new, applies to every role; the manager gets a tight one). Both are new `budgetGate` inputs with their own deny reasons. Fan-out is bounded by roster size per manager turn and by the Workspace-1 concurrency gate. (§6) |
| Different thing from ORCH's governance-plane role, or informed by DEVDEPARTMENT? | **Informed, not shared.** ORCH is the *platform's* development orchestrator; a manager bot is a *user's* product feature. The patterns transfer as data shapes: PLAN.md task block → `project_tasks`; Owned_Paths → artifact ownership; `needs_review` → task state `review`; Review_Findings → `project_decisions`. No DEVDEPARTMENT code is reused. (§7) |

## 1. Product shape

1.1 A user creates a Project with a goal and a done-criterion, picks up to six existing
bots for the roster (matching `GROUP_MEMBER_CAP`), optionally marks one as manager, and
gets: one group channel, one task board, one artifact register, one decision log, one
status. Multi-bot work has shared state beyond the channel's message history.

1.2 "Interview once, reuse every run": the Project **charter** (goal, done criterion,
boundaries, "check with me before…") is captured at creation and stored as
project-scope `profile`-tier memory facts, so every member's prompt sees it through the
existing memory injection without any bot re-asking.

1.3 "If there's nothing to report, send nothing": the manager's status routine uses the
existing `notify_threshold: changes_only` and compares against the last status
artifact.

1.4 "A state file avoids duplicate reporting": the project's status is an artifact
(`STATUS.md`) the manager regenerates, registered with provenance, not a message.

1.5 "Handoff quality is a file format problem": delegation and completion are **typed
handoffs** carrying artifact references, not free-text.

## 2. Entity

```sql
CREATE TABLE projects (
  project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  thread_id uuid NOT NULL UNIQUE REFERENCES threads(id),
  name text NOT NULL,
  goal text NOT NULL,
  done_criterion text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  budget_usd numeric(14,6) NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_roles (          -- extends thread_members; the roster is the thread's
  project_id uuid REFERENCES projects(project_id),
  role_id text REFERENCES roles(role_id),
  is_manager boolean NOT NULL DEFAULT false,
  responsibility text NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, role_id)
);
```

2.1 Exactly one manager per project (partial unique index on `is_manager`). A project
with no manager is valid: the human is the manager.
2.2 Creating a project creates its group thread through the existing
`POST /threads/group` path; roster changes go through `thread_members` and
`project_roles` in one transaction. Ownership rule: a project is the principal's if its
thread is (`findTenantOwnedThread`, 404-never-403).
2.3 `profile_facts.project_id` (existing, `005_agent_memory.up.sql`) references
`projects.project_id` from this migration on; project-scope memory becomes real.

## 3. Task board

```sql
CREATE TABLE project_tasks (
  task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(project_id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_role_id text NULL REFERENCES roles(role_id),
  state text NOT NULL DEFAULT 'todo' CHECK (state IN ('todo','doing','blocked','review','done','cancelled')),
  blocked_reason text NULL,
  done_criterion text NOT NULL DEFAULT '',
  created_by text NOT NULL,            -- 'human:<uid>' | 'role:<role_id>'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL))
);
CREATE TABLE project_task_runs (
  task_id uuid REFERENCES project_tasks(task_id),
  run_id uuid REFERENCES runs(run_id),
  PRIMARY KEY (task_id, run_id)
);
```

3.1 State machine: `todo → doing → review → done`; `blocked` reachable from `doing`
with a mandatory reason; `cancelled` from any non-done. Transitions are audited
(`project.task_transition {task_id, from, to, actor}`).
3.2 A work item's owner must be on the roster. Assigning a work item to a role sends a
typed handoff `task.assigned` (§5) to that role; it does not start a run by itself.
3.3 Blocked is first-class and visible: the Workspace-1 summary endpoint (TASK-237)
gains `blockedTasks` per project thread.

## 4. Artifact register

```sql
CREATE TABLE project_artifacts (
  artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(project_id),
  task_id uuid NULL REFERENCES project_tasks(task_id),
  kind text NOT NULL CHECK (kind IN ('workspace_file','attachment','run_receipt')),
  ref text NOT NULL,                  -- D1 path | attachment id | run id
  sha256 text NULL,
  byte_size integer NULL,
  produced_by_role_id text NULL REFERENCES roles(role_id),
  produced_by_run_id uuid NULL REFERENCES runs(run_id),
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

4.1 `workspace_file` refs must resolve under `/oikonomos/workspace/projects/<project_id>/`
via `resolveWorkspacePath` (D1 only; D3 and traversal rejected as today). The directory is
created with the project.
4.2 Registering is explicit (a broker tool or API call), never inferred from a file
appearing on disk. The register is the source of truth for "what did this project
produce".
4.3 `STATUS.md` is a reserved label regenerated by the manager's status routine.

## 5. Typed handoffs (extends ADR-012's closed set)

5.1 `handoffKinds` gains `task.assigned`, `task.completed`, `task.blocked`,
`status.requested`. `fact_ref` continues to be a locator; the new kinds carry
`{project_id, task_id, artifact_ids[]}` in the same locator-only discipline (no bytes,
no values — the existing CHECK that forbids a `value` key stays).
5.2 `task.completed` must reference at least one registered artifact or a run receipt;
the receiver (manager or human) re-reads it live.
5.3 Delivery stays `role_messages` (async mailbox, no privilege carried, F8/R13). A
handoff never grants anything.

## 6. Budget

6.1 `spend_records` gains `project_id text NULL` (text, like `run_id`/`routine_id`, no
FK). Every run started from a project thread or from a `task.assigned` handoff is
attributed to the project.
6.2 `budgetGate` gains `{projectSpendUsd, projectBudgetUsd}` and
`{roleSpendUsd, roleBudgetUsd}` with deny reasons `budget.project_exceeded` and
`budget.role_exceeded`. Per-role budget is a new `roles.budget_usd numeric NULL`
(NULL = no role ceiling). Platform ceiling and per-routine budget are unchanged and
still evaluated first.
6.3 The manager role's budget covers only its own turns; specialists' runs are charged
to the specialists and to the project. A manager cannot raise any budget.
6.4 Fan-out: one manager turn may emit at most `roster size` `task.assigned` handoffs
(enforced in the broker tool, audited as `project.fanout_capped` when hit); the
Workspace-1 concurrency gate (two executing runs, per-role serialisation) bounds
simultaneous execution.

## 7. Manager role

7.1 A manager is a role with `project_roles.is_manager = true` and grants for the
`project.*` capabilities below. Its instructions are seeded from a reviewed
"Engineering Manager / Chief of Staff" charter (prose, TASK-181 mechanism): decompose
the goal into work items, assign to roster members by responsibility, check evidence
(artifacts, receipts) against each item's done criterion, mark `review`/`done`, mark
`blocked` with the reason, regenerate `STATUS.md`, escalate to the human only for
decisions.

7.2 Broker tools (declared in `packages/broker/src/builtinTools.ts`, adapter
`sdk:builtin`, mounted through the existing workspace MCP server pattern):

| tool_name | capability_id | default_tier | enabled |
|---|---|---|---|
| `mcp__project__list_board` | `project.read` | T0_observe | true |
| `mcp__project__create_task` | `project.task_write` | T2_internal | true |
| `mcp__project__update_task` | `project.task_write` | T2_internal | true |
| `mcp__project__assign_task` | `project.assign` | T2_internal | true |
| `mcp__project__register_artifact` | `project.artifact_write` | T2_internal | true |
| `mcp__project__record_decision` | `project.decision_write` | T2_internal | true |
| `mcp__project__create_role` | `project.create_role` | T4_irreversible | **false** |
| `mcp__project__request_grant` | `project.request_grant` | T3_external | **false** |

7.3 The two disabled tools exist so that ADR-010's approval boundary has a home: when
a later ADR enables them, they are already on the enforced side (T3/T4 park by default)
and a `require_approval_rules` row for the manager role makes the human the approver of
every bot creation and every grant. Until then, `CapabilityRegistry` construction and
L1 both refuse them (`capability.disabled`), and a test asserts the manager cannot
create a role or a grant through any path.

7.4 A project with no manager exposes the same board to the human through the API and
UI; the manager is optional automation, not a prerequisite.

7.5 Relation to DEVDEPARTMENT: the patterns are mirrored as data (task block →
`project_tasks`; territory → artifact ownership; `needs_review` → `review`; review
findings → `project_decisions`; the "verify claims, don't trust Test_Evidence" rule →
`task.completed` must carry artifacts the manager re-reads). No code, hooks or scripts
from `scripts/`, `hooks/` or `.claude/` are reused or exposed.

## 8. Decision log

```sql
CREATE TABLE project_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(project_id),
  task_id uuid NULL REFERENCES project_tasks(task_id),
  kind text NOT NULL CHECK (kind IN ('approval','human_decision','manager_decision','review_finding')),
  approval_id uuid NULL REFERENCES approvals(approval_id),
  summary text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

8.1 Approvals decided on any run attributed to the project are mirrored here by
reference (`approval_id`), never by copying the action render.

## 9. API and UI

9.1 Routes: `POST /projects`, `GET /projects`, `GET /projects/:id` (charter, roster,
board summary, latest status artifact, spend vs budget), `PATCH /projects/:id`
(status, budget, roster), `GET|POST /projects/:id/tasks`, `PATCH /projects/:id/tasks/:taskId`,
`GET|POST /projects/:id/artifacts`, `GET /projects/:id/decisions`. All tenant-scoped via
the thread ownership rule.
9.2 UI: the Workspace-1 Work view (TASK-243) becomes the board when the thread is a
project's; the Results view lists the artifact register; the attention inbox lists
`blocked` items with their reason.

## 10. Proposed tasks (decompose input; Owned_Paths are proposals)

| # | Scope | Owned_Paths (proposal) | Review |
|---|---|---|---|
| P-1 | Migration: `projects`, `project_roles`, `project_tasks`, `project_task_runs`, `project_artifacts`, `project_decisions`, `spend_records.project_id`, `roles.budget_usd`; `packages/db/src/projects*` | `infra/postgres/migrations/02N_projects.*`, `packages/db/src/projects*`, `packages/db/src/spend.ts` | standard |
| P-2 | Typed handoff kinds + locator CHECK extension; `sendToRole` additive fields | `packages/db/src/roleMessages*`, `services/workspace/src/mailbox*` | adversarial (ACL-adjacent, ADR-012 §6 precedent) |
| P-3 | Budget gate inputs + deny reasons; spend attribution to project and role | `packages/broker/src/budgetGate*` ⚑ protected, `services/worker/src/subprocessProviders.ts`, `services/worker/src/chatRunDriver.ts` (attribution only) | adversarial, different model |
| P-4 | `project.*` built-in tools + declared-disabled creation/grant rows; fan-out cap; workspace MCP server wiring | `packages/broker/src/builtinTools.ts` ⚑ protected, `services/worker/src/projectTools*`, `services/worker/src/workspaceMcpServer.ts` | adversarial, different model |
| P-5 | control-api project routes + summary `blockedTasks` | `services/control-api/src/projects.routes.ts` + test, `openapi.ts`, `ports.ts` (port only) | standard |
| P-6 | Manager charter (prose) + status routine template | `services/control-api/src/charters/**`, `apps/mobile/lib/charter/**` | standard |
| P-7 | Dashboard board/register/attention on the Workspace-1 views; mobile project screens | `apps/dashboard/src/components/workspace/project/**`, `apps/mobile/lib/screens/project*` | standard |

Sequencing: P-1 → P-2 ∥ P-3 ∥ P-4 → P-5 → P-6 ∥ P-7. Conflicts with Wave Workspace-1:
P-3 shares `chatRunDriver.ts` with TASK-244/246 (sequence after them); P-5 shares
`app.ts`/`ports.ts` with TASK-242 (sequence after); P-7 builds on TASK-243.

## 11. Acceptance criteria (spec-level; tasks inherit)

- Creating a project creates exactly one group thread, a roster of ≤ 6, at most one manager, the D1 project directory, and the charter as project-scope memory facts visible to every member's next run and to no non-member. (§1.2, §2)
- A work item cannot be `blocked` without a reason, cannot be owned by a non-member, and every transition is an audit event. (§3)
- `task.completed` without an artifact reference is rejected; a `workspace_file` artifact outside the project directory is rejected; artifact rows never contain bytes. (§4, §5.2)
- A manager run that attempts `mcp__project__create_role` or `mcp__project__request_grant` is denied `capability.disabled` at L1 and the tools are absent from the mount; a test proves no code path writes `roles` or `role_grants` from a manager turn. (§7.3)
- A project whose spend reaches `budget_usd` has its next attributed run denied `budget.project_exceeded`; a manager role at its `roles.budget_usd` is denied `budget.role_exceeded` while specialists continue. (§6)
- One manager turn cannot emit more `task.assigned` handoffs than roster members. (§6.4)
- The manager's status routine sends nothing when `STATUS.md` is unchanged. (§1.3)
- The Workspace-1 summary reports `blockedTasks` for the project thread. (§3.3)
