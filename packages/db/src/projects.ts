import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";
import type { RiskTier } from "./types.js";

/**
 * TASK-276 / ADR-019 §§2,3,4,8 (specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md
 * §§2-4,8). Foundation storage only — no manager-role tools, no capability
 * wiring, no budget reservation, no API routes (all later tasks). This
 * module is a typed CRUD layer over the four tables migrated in
 * `infra/postgres/migrations/027_project_workspace.up.sql`: `projects`,
 * `project_tasks`, `project_artifacts`, `project_decisions`. Mirrors
 * roles.ts's shape (createRole/getRole/listRoles) per this task's own
 * Acceptance_Criteria. `project_roles` and `project_task_runs` are real
 * ADR-019 tables but are out of this task's scope — not created, not
 * queried here.
 */

export const projectStatuses = ["active", "paused", "done", "archived"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const projectTaskStates = ["todo", "doing", "blocked", "review", "done", "cancelled"] as const;
export type ProjectTaskState = (typeof projectTaskStates)[number];

export const projectArtifactKinds = ["workspace_file", "attachment", "run_receipt"] as const;
export type ProjectArtifactKind = (typeof projectArtifactKinds)[number];

export const projectDecisionKinds = [
  "approval",
  "human_decision",
  "manager_decision",
  "review_finding",
] as const;
export type ProjectDecisionKind = (typeof projectDecisionKinds)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function requireUuid(value: string, field: string): string {
  const trimmed = requireNonEmpty(value, field);
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`${field} must be a UUID.`);
  }
  return trimmed;
}

function requireOptionalUuid(value: string | undefined | null, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireUuid(value, field);
}

function oneOf<T extends string>(values: readonly T[], value: T, field: string): T {
  if (!values.includes(value)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}.`);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* projects                                                            */
/* ------------------------------------------------------------------ */

export interface NewProject {
  tenantId: string;
  /** The existing group thread this Project binds to 1:1 (ADR-019 §2). */
  threadId: string;
  name: string;
  goal: string;
  doneCriterion: string;
  status?: ProjectStatus;
  budgetUsd?: number | null;
  createdBy: string;
}

export interface Project {
  projectId: string;
  tenantId: string;
  threadId: string;
  name: string;
  goal: string;
  doneCriterion: string;
  status: ProjectStatus;
  budgetUsd: number | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectListFilter {
  tenantId: string;
  status?: ProjectStatus;
}

interface ProjectRow extends QueryResultRow {
  project_id: string;
  tenant_id: string;
  thread_id: string;
  name: string;
  goal: string;
  done_criterion: string;
  status: ProjectStatus;
  budget_usd: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const projectColumns = `project_id, tenant_id, thread_id, name, goal, done_criterion, status, budget_usd, created_by, created_at, updated_at`;

function toProject(row: ProjectRow): Project {
  return {
    projectId: row.project_id,
    tenantId: row.tenant_id,
    threadId: row.thread_id,
    name: row.name,
    goal: row.goal,
    doneCriterion: row.done_criterion,
    status: row.status,
    budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createProject(
  options: DatabaseOptions,
  input: NewProject,
): Promise<Project> {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const threadId = requireUuid(input.threadId, "threadId");
  const name = requireNonEmpty(input.name, "name");
  const goal = requireNonEmpty(input.goal, "goal");
  const doneCriterion = requireNonEmpty(input.doneCriterion, "doneCriterion");
  const createdBy = requireNonEmpty(input.createdBy, "createdBy");
  const status = oneOf(projectStatuses, input.status ?? "active", "status");
  const budgetUsd = input.budgetUsd ?? null;

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectRow>(
      `INSERT INTO projects (tenant_id, thread_id, name, goal, done_criterion, status, budget_usd, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${projectColumns}`,
      [tenantId, threadId, name, goal, doneCriterion, status, budgetUsd, createdBy],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createProject did not return a persisted row.");
    }
    return toProject(row);
  });
}

export async function getProject(
  options: DatabaseOptions,
  projectId: string,
): Promise<Project | null> {
  const normalizedProjectId = requireUuid(projectId, "projectId");

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectRow>(
      `SELECT ${projectColumns} FROM projects WHERE project_id = $1`,
      [normalizedProjectId],
    );
    return result.rows[0] === undefined ? null : toProject(result.rows[0]);
  });
}

/** A Project is bound 1:1 to its thread (`thread_id UNIQUE`, ADR-019 §2). */
export async function getProjectByThreadId(
  options: DatabaseOptions,
  threadId: string,
): Promise<Project | null> {
  const normalizedThreadId = requireUuid(threadId, "threadId");

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectRow>(
      `SELECT ${projectColumns} FROM projects WHERE thread_id = $1`,
      [normalizedThreadId],
    );
    return result.rows[0] === undefined ? null : toProject(result.rows[0]);
  });
}

export async function listProjects(
  options: DatabaseOptions,
  filter: ProjectListFilter,
): Promise<Project[]> {
  const tenantId = requireNonEmpty(filter.tenantId, "tenantId");
  const conditions = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];

  if (filter.status !== undefined) {
    params.push(oneOf(projectStatuses, filter.status, "status"));
    conditions.push(`status = $${params.length}`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectRow>(
      `SELECT ${projectColumns} FROM projects
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC`,
      params,
    );
    return result.rows.map(toProject);
  });
}

export async function updateProjectStatus(
  options: DatabaseOptions,
  projectId: string,
  status: ProjectStatus,
): Promise<Project | null> {
  const normalizedProjectId = requireUuid(projectId, "projectId");
  const normalizedStatus = oneOf(projectStatuses, status, "status");

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectRow>(
      `UPDATE projects SET status = $2, updated_at = now() WHERE project_id = $1
       RETURNING ${projectColumns}`,
      [normalizedProjectId, normalizedStatus],
    );
    return result.rows[0] === undefined ? null : toProject(result.rows[0]);
  });
}

/* ------------------------------------------------------------------ */
/* project_tasks                                                       */
/* ------------------------------------------------------------------ */

export interface NewProjectTask {
  projectId: string;
  title: string;
  description?: string;
  ownerRoleId?: string | null;
  doneCriterion?: string;
  /** Initial state (default `todo`); `blocked` requires `blockedReason` (spec §3). */
  state?: ProjectTaskState;
  blockedReason?: string;
  /** `'human:<uid>'` | `'role:<role_id>'` per spec §3. */
  createdBy: string;
}

export interface ProjectTask {
  taskId: string;
  projectId: string;
  title: string;
  description: string;
  ownerRoleId: string | null;
  state: ProjectTaskState;
  blockedReason: string | null;
  doneCriterion: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectTaskListFilter {
  projectId: string;
  state?: ProjectTaskState;
}

interface ProjectTaskRow extends QueryResultRow {
  task_id: string;
  project_id: string;
  title: string;
  description: string;
  owner_role_id: string | null;
  state: ProjectTaskState;
  blocked_reason: string | null;
  done_criterion: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const projectTaskColumns = `task_id, project_id, title, description, owner_role_id, state, blocked_reason, done_criterion, created_by, created_at, updated_at`;

function toProjectTask(row: ProjectTaskRow): ProjectTask {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    ownerRoleId: row.owner_role_id,
    state: row.state,
    blockedReason: row.blocked_reason,
    doneCriterion: row.done_criterion,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createProjectTask(
  options: DatabaseOptions,
  input: NewProjectTask,
): Promise<ProjectTask> {
  const projectId = requireUuid(input.projectId, "projectId");
  const title = requireNonEmpty(input.title, "title");
  const description = input.description ?? "";
  const ownerRoleId = requireOptionalNonEmpty(input.ownerRoleId ?? undefined, "ownerRoleId");
  const doneCriterion = input.doneCriterion ?? "";
  const createdBy = requireNonEmpty(input.createdBy, "createdBy");
  const state = oneOf(projectTaskStates, input.state ?? "todo", "state");
  const blockedReason =
    state === "blocked" ? requireNonEmpty(input.blockedReason ?? "", "blockedReason") : null;

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectTaskRow>(
      `INSERT INTO project_tasks (project_id, title, description, owner_role_id, done_criterion, created_by, state, blocked_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${projectTaskColumns}`,
      [projectId, title, description, ownerRoleId, doneCriterion, createdBy, state, blockedReason],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createProjectTask did not return a persisted row.");
    }
    return toProjectTask(row);
  });
}

export async function getProjectTask(
  options: DatabaseOptions,
  taskId: string,
): Promise<ProjectTask | null> {
  const normalizedTaskId = requireUuid(taskId, "taskId");

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectTaskRow>(
      `SELECT ${projectTaskColumns} FROM project_tasks WHERE task_id = $1`,
      [normalizedTaskId],
    );
    return result.rows[0] === undefined ? null : toProjectTask(result.rows[0]);
  });
}

export async function listProjectTasks(
  options: DatabaseOptions,
  filter: ProjectTaskListFilter,
): Promise<ProjectTask[]> {
  const projectId = requireUuid(filter.projectId, "projectId");
  const conditions = ["project_id = $1"];
  const params: unknown[] = [projectId];

  if (filter.state !== undefined) {
    params.push(oneOf(projectTaskStates, filter.state, "state"));
    conditions.push(`state = $${params.length}`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectTaskRow>(
      `SELECT ${projectTaskColumns} FROM project_tasks
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at`,
      params,
    );
    return result.rows.map(toProjectTask);
  });
}

/**
 * Transition a work item's state. `blocked` requires a non-empty
 * `blockedReason`; every other state clears it — mirrors the table's own
 * `CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL))` (spec §3) so
 * a caller gets a clear TS-level error instead of a raw constraint
 * violation. State-machine legality (e.g. `done -> doing`) is deliberately
 * NOT enforced here — that is application business logic (spec §3.1),
 * out of scope for this storage-only layer.
 */
export async function updateProjectTaskState(
  options: DatabaseOptions,
  taskId: string,
  state: ProjectTaskState,
  blockedReason?: string,
): Promise<ProjectTask | null> {
  const normalizedTaskId = requireUuid(taskId, "taskId");
  const normalizedState = oneOf(projectTaskStates, state, "state");
  const normalizedReason =
    normalizedState === "blocked" ? requireNonEmpty(blockedReason ?? "", "blockedReason") : null;

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectTaskRow>(
      `UPDATE project_tasks SET state = $2, blocked_reason = $3, updated_at = now() WHERE task_id = $1
       RETURNING ${projectTaskColumns}`,
      [normalizedTaskId, normalizedState, normalizedReason],
    );
    return result.rows[0] === undefined ? null : toProjectTask(result.rows[0]);
  });
}

/**
 * Set the owner of an existing project task. Roster membership and manager
 * authority are intentionally enforced by the project-tool handler (TASK-302),
 * not this storage-layer accessor.
 */
export async function assignProjectTaskOwner(
  options: DatabaseOptions,
  taskId: string,
  ownerRoleId: string,
): Promise<ProjectTask | null> {
  const normalizedTaskId = requireUuid(taskId, "taskId");
  const normalizedOwnerRoleId = requireUuid(ownerRoleId, "ownerRoleId");

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectTaskRow>(
      `UPDATE project_tasks SET owner_role_id = $2, updated_at = now() WHERE task_id = $1
       RETURNING ${projectTaskColumns}`,
      [normalizedTaskId, normalizedOwnerRoleId],
    );
    return result.rows[0] === undefined ? null : toProjectTask(result.rows[0]);
  });
}

/* ------------------------------------------------------------------ */
/* project_artifacts                                                    */
/* ------------------------------------------------------------------ */

export interface NewProjectArtifact {
  projectId: string;
  taskId?: string | null;
  kind: ProjectArtifactKind;
  /** D1 workspace path | attachment id | run id (spec §4). */
  ref: string;
  sha256?: string | null;
  byteSize?: number | null;
  producedByRoleId?: string | null;
  producedByRunId?: string | null;
  label: string;
}

export interface ProjectArtifact {
  artifactId: string;
  projectId: string;
  taskId: string | null;
  kind: ProjectArtifactKind;
  ref: string;
  sha256: string | null;
  byteSize: number | null;
  producedByRoleId: string | null;
  producedByRunId: string | null;
  label: string;
  createdAt: Date;
}

export interface ProjectArtifactListFilter {
  projectId: string;
  taskId?: string;
}

interface ProjectArtifactRow extends QueryResultRow {
  artifact_id: string;
  project_id: string;
  task_id: string | null;
  kind: ProjectArtifactKind;
  ref: string;
  sha256: string | null;
  byte_size: number | null;
  produced_by_role_id: string | null;
  produced_by_run_id: string | null;
  label: string;
  created_at: Date;
}

const projectArtifactColumns = `artifact_id, project_id, task_id, kind, ref, sha256, byte_size, produced_by_role_id, produced_by_run_id, label, created_at`;

function toProjectArtifact(row: ProjectArtifactRow): ProjectArtifact {
  return {
    artifactId: row.artifact_id,
    projectId: row.project_id,
    taskId: row.task_id,
    kind: row.kind,
    ref: row.ref,
    sha256: row.sha256,
    byteSize: row.byte_size,
    producedByRoleId: row.produced_by_role_id,
    producedByRunId: row.produced_by_run_id,
    label: row.label,
    createdAt: row.created_at,
  };
}

function requireOptionalNonEmpty(value: string | undefined, field: string): string | null {
  if (value === undefined) {
    return null;
  }
  return requireNonEmpty(value, field);
}

export async function createProjectArtifact(
  options: DatabaseOptions,
  input: NewProjectArtifact,
): Promise<ProjectArtifact> {
  const projectId = requireUuid(input.projectId, "projectId");
  const taskId = requireOptionalUuid(input.taskId ?? undefined, "taskId");
  const kind = oneOf(projectArtifactKinds, input.kind, "kind");
  const ref = requireNonEmpty(input.ref, "ref");
  const label = requireNonEmpty(input.label, "label");
  const sha256 = requireOptionalNonEmpty(input.sha256 ?? undefined, "sha256");
  const byteSize = input.byteSize ?? null;
  if (byteSize !== null && (!Number.isInteger(byteSize) || byteSize < 0)) {
    throw new Error("byteSize must be a non-negative integer.");
  }
  const producedByRoleId = requireOptionalNonEmpty(input.producedByRoleId ?? undefined, "producedByRoleId");
  const producedByRunId = requireOptionalUuid(input.producedByRunId ?? undefined, "producedByRunId");

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectArtifactRow>(
      `INSERT INTO project_artifacts (project_id, task_id, kind, ref, sha256, byte_size, produced_by_role_id, produced_by_run_id, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${projectArtifactColumns}`,
      [projectId, taskId, kind, ref, sha256, byteSize, producedByRoleId, producedByRunId, label],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createProjectArtifact did not return a persisted row.");
    }
    return toProjectArtifact(row);
  });
}

export async function getProjectArtifact(
  options: DatabaseOptions,
  artifactId: string,
): Promise<ProjectArtifact | null> {
  const normalizedArtifactId = requireUuid(artifactId, "artifactId");

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectArtifactRow>(
      `SELECT ${projectArtifactColumns} FROM project_artifacts WHERE artifact_id = $1`,
      [normalizedArtifactId],
    );
    return result.rows[0] === undefined ? null : toProjectArtifact(result.rows[0]);
  });
}

export async function listProjectArtifacts(
  options: DatabaseOptions,
  filter: ProjectArtifactListFilter,
): Promise<ProjectArtifact[]> {
  const projectId = requireUuid(filter.projectId, "projectId");
  const conditions = ["project_id = $1"];
  const params: unknown[] = [projectId];

  if (filter.taskId !== undefined) {
    params.push(requireUuid(filter.taskId, "taskId"));
    conditions.push(`task_id = $${params.length}`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectArtifactRow>(
      `SELECT ${projectArtifactColumns} FROM project_artifacts
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC`,
      params,
    );
    return result.rows.map(toProjectArtifact);
  });
}

/* ------------------------------------------------------------------ */
/* project_decisions                                                    */
/* ------------------------------------------------------------------ */

export interface NewProjectDecision {
  projectId: string;
  taskId?: string | null;
  kind: ProjectDecisionKind;
  approvalId?: string | null;
  summary: string;
  actor: string;
}

export interface ProjectDecision {
  decisionId: string;
  projectId: string;
  taskId: string | null;
  kind: ProjectDecisionKind;
  approvalId: string | null;
  summary: string;
  actor: string;
  createdAt: Date;
}

export interface ProjectDecisionListFilter {
  projectId: string;
  taskId?: string;
}

interface ProjectDecisionRow extends QueryResultRow {
  decision_id: string;
  project_id: string;
  task_id: string | null;
  kind: ProjectDecisionKind;
  approval_id: string | null;
  summary: string;
  actor: string;
  created_at: Date;
}

const projectDecisionColumns = `decision_id, project_id, task_id, kind, approval_id, summary, actor, created_at`;

function toProjectDecision(row: ProjectDecisionRow): ProjectDecision {
  return {
    decisionId: row.decision_id,
    projectId: row.project_id,
    taskId: row.task_id,
    kind: row.kind,
    approvalId: row.approval_id,
    summary: row.summary,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

/**
 * Approvals are mirrored here by reference only (`approvalId`), never by
 * copying the action render (spec §8.1).
 */
export async function createProjectDecision(
  options: DatabaseOptions,
  input: NewProjectDecision,
): Promise<ProjectDecision> {
  const projectId = requireUuid(input.projectId, "projectId");
  const taskId = requireOptionalUuid(input.taskId ?? undefined, "taskId");
  const kind = oneOf(projectDecisionKinds, input.kind, "kind");
  const approvalId = requireOptionalUuid(input.approvalId ?? undefined, "approvalId");
  const summary = requireNonEmpty(input.summary, "summary");
  const actor = requireNonEmpty(input.actor, "actor");

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectDecisionRow>(
      `INSERT INTO project_decisions (project_id, task_id, kind, approval_id, summary, actor)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${projectDecisionColumns}`,
      [projectId, taskId, kind, approvalId, summary, actor],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createProjectDecision did not return a persisted row.");
    }
    return toProjectDecision(row);
  });
}

export async function getProjectDecision(
  options: DatabaseOptions,
  decisionId: string,
): Promise<ProjectDecision | null> {
  const normalizedDecisionId = requireUuid(decisionId, "decisionId");

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectDecisionRow>(
      `SELECT ${projectDecisionColumns} FROM project_decisions WHERE decision_id = $1`,
      [normalizedDecisionId],
    );
    return result.rows[0] === undefined ? null : toProjectDecision(result.rows[0]);
  });
}

export async function listProjectDecisions(
  options: DatabaseOptions,
  filter: ProjectDecisionListFilter,
): Promise<ProjectDecision[]> {
  const projectId = requireUuid(filter.projectId, "projectId");
  const conditions = ["project_id = $1"];
  const params: unknown[] = [projectId];

  if (filter.taskId !== undefined) {
    params.push(requireUuid(filter.taskId, "taskId"));
    conditions.push(`task_id = $${params.length}`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectDecisionRow>(
      `SELECT ${projectDecisionColumns} FROM project_decisions
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at`,
      params,
    );
    return result.rows.map(toProjectDecision);
  });
}

/* ------------------------------------------------------------------ */
/* project_roles (roster + manager) and project_task_runs — TASK-298   */
/* ------------------------------------------------------------------ */

/**
 * Spec §1.1: a project roster is bounded by the group-thread member cap.
 * Mirrors `GROUP_MEMBER_CAP` in services/worker/src/groupRouting.ts, which
 * packages/db cannot import (dependency direction) — keep the two in step.
 */
export const PROJECT_ROSTER_CAP = 6;

export interface ProjectRoleMember {
  projectId: string;
  roleId: string;
  isManager: boolean;
  responsibility: string;
}

interface ProjectRoleRow extends QueryResultRow {
  project_id: string;
  role_id: string;
  is_manager: boolean;
  responsibility: string;
}

const projectRoleColumns = `project_id, role_id, is_manager, responsibility`;

function toProjectRoleMember(row: ProjectRoleRow): ProjectRoleMember {
  return {
    projectId: row.project_id,
    roleId: row.role_id,
    isManager: row.is_manager,
    responsibility: row.responsibility,
  };
}

export interface NewProjectRoleMember {
  projectId: string;
  roleId: string;
  isManager?: boolean;
  responsibility?: string;
}

/**
 * Adds (or updates) a roster member. Spec §2.2: `thread_members` and
 * `project_roles` change in ONE transaction, so a failure leaves neither
 * touched. The project row is locked first so concurrent adds cannot both
 * pass the cap check. A second `is_manager = true` row for the project is
 * rejected by the partial unique index (spec §2.1), which rolls the whole
 * transaction back.
 */
export async function addProjectRoleMember(
  options: DatabaseOptions,
  input: NewProjectRoleMember,
): Promise<ProjectRoleMember> {
  const projectId = requireUuid(input.projectId, "projectId");
  const roleId = requireNonEmpty(input.roleId, "roleId");
  const isManager = input.isManager ?? false;
  const responsibility = input.responsibility ?? "";

  return withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<{ thread_id: string }>(
        "SELECT thread_id FROM projects WHERE project_id = $1 FOR UPDATE",
        [projectId],
      );
      const threadId = project.rows[0]?.thread_id;
      if (threadId === undefined) {
        throw new Error(`project ${projectId} does not exist.`);
      }
      const existing = await client.query<{ role_id: string }>(
        "SELECT role_id FROM project_roles WHERE project_id = $1",
        [projectId],
      );
      const alreadyMember = existing.rows.some((row) => row.role_id === roleId);
      if (!alreadyMember && existing.rows.length >= PROJECT_ROSTER_CAP) {
        throw new Error(`a project roster supports at most ${PROJECT_ROSTER_CAP} members.`);
      }
      await client.query(
        `INSERT INTO thread_members (thread_id, role_id) VALUES ($1, $2)
         ON CONFLICT (thread_id, role_id) DO NOTHING`,
        [threadId, roleId],
      );
      const result = await client.query<ProjectRoleRow>(
        `INSERT INTO project_roles (project_id, role_id, is_manager, responsibility)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, role_id)
         DO UPDATE SET is_manager = EXCLUDED.is_manager, responsibility = EXCLUDED.responsibility
         RETURNING ${projectRoleColumns}`,
        [projectId, roleId, isManager, responsibility],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("addProjectRoleMember did not return a persisted row.");
      }
      await client.query("COMMIT");
      return toProjectRoleMember(row);
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

/**
 * Removes a roster member from `project_roles` and `thread_members` in one
 * transaction (spec §2.2). Returns false when the role was not on the roster.
 */
export async function removeProjectRoleMember(
  options: DatabaseOptions,
  input: { projectId: string; roleId: string },
): Promise<boolean> {
  const projectId = requireUuid(input.projectId, "projectId");
  const roleId = requireNonEmpty(input.roleId, "roleId");

  return withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<{ thread_id: string }>(
        "SELECT thread_id FROM projects WHERE project_id = $1 FOR UPDATE",
        [projectId],
      );
      const threadId = project.rows[0]?.thread_id;
      if (threadId === undefined) {
        throw new Error(`project ${projectId} does not exist.`);
      }
      const removed = await client.query(
        "DELETE FROM project_roles WHERE project_id = $1 AND role_id = $2",
        [projectId, roleId],
      );
      await client.query("DELETE FROM thread_members WHERE thread_id = $1 AND role_id = $2", [
        threadId,
        roleId,
      ]);
      await client.query("COMMIT");
      return (removed.rowCount ?? 0) > 0;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function listProjectRoleMembers(
  options: DatabaseOptions,
  projectId: string,
): Promise<ProjectRoleMember[]> {
  const id = requireUuid(projectId, "projectId");
  return withPool(options, async (pool) => {
    const result = await pool.query<ProjectRoleRow>(
      `SELECT ${projectRoleColumns} FROM project_roles WHERE project_id = $1 ORDER BY role_id`,
      [id],
    );
    return result.rows.map(toProjectRoleMember);
  });
}

/**
 * Makes `roleId` the project's manager, or clears the manager when `roleId`
 * is null (the human is the manager, spec §2.1). Demote-then-promote runs in
 * one transaction so the one-manager index is never violated mid-swap. The
 * role must already be on the roster.
 */
export async function setProjectManager(
  options: DatabaseOptions,
  input: { projectId: string; roleId: string | null },
): Promise<void> {
  const projectId = requireUuid(input.projectId, "projectId");
  const roleId = input.roleId === null ? null : requireNonEmpty(input.roleId, "roleId");

  await withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM projects WHERE project_id = $1 FOR UPDATE", [projectId]);
      await client.query(
        "UPDATE project_roles SET is_manager = false WHERE project_id = $1 AND is_manager",
        [projectId],
      );
      if (roleId !== null) {
        const promoted = await client.query(
          "UPDATE project_roles SET is_manager = true WHERE project_id = $1 AND role_id = $2",
          [projectId, roleId],
        );
        if (promoted.rowCount !== 1) {
          throw new Error(`role ${roleId} is not on the roster of project ${projectId}.`);
        }
      }
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

/** Links a work item to a run (spec §3); idempotent on the (task, run) pair. */
export async function linkProjectTaskRun(
  options: DatabaseOptions,
  input: { taskId: string; runId: string },
): Promise<void> {
  const taskId = requireUuid(input.taskId, "taskId");
  const runId = requireUuid(input.runId, "runId");
  await withPool(options, async (pool) => {
    await pool.query(
      `INSERT INTO project_task_runs (task_id, run_id) VALUES ($1, $2)
       ON CONFLICT (task_id, run_id) DO NOTHING`,
      [taskId, runId],
    );
  });
}

export async function listProjectTaskRunIds(
  options: DatabaseOptions,
  taskId: string,
): Promise<string[]> {
  const id = requireUuid(taskId, "taskId");
  return withPool(options, async (pool) => {
    const result = await pool.query<{ run_id: string }>(
      "SELECT run_id FROM project_task_runs WHERE task_id = $1 ORDER BY run_id",
      [id],
    );
    return result.rows.map((row) => row.run_id);
  });
}

/* ------------------------------------------------------------------ */
/* TASK-304 (P-5): atomic project create / update, overview, mirror    */
/* ------------------------------------------------------------------ */

/**
 * Capabilities a manager may hold via the project routes (spec §7.2, §7.2a
 * v1.3, ADR-019 Amendment 2026-09-19): the enabled `project.*` set plus
 * `workspace.create_bot`. Anything that writes grants or roles, and
 * `workspace.retire_bot` until TASK-313, is refused here so a caller bug
 * cannot widen a manager, regardless of what the route resolved.
 */
const MANAGER_GRANT_DENYLIST = new Set([
  "project.request_grant",
  "project.create_role",
  "workspace.retire_bot",
]);

const CREATE_BOT_CAPABILITY = "workspace.create_bot";

export interface ManagerGrantInput {
  capabilityId: string;
  maxTier: RiskTier;
}

function requireManagerGrants(grants: readonly ManagerGrantInput[]): ManagerGrantInput[] {
  return grants.map((grant) => {
    const capabilityId = requireNonEmpty(grant.capabilityId, "capabilityId");
    const isProjectCapability = capabilityId.startsWith("project.");
    if (
      MANAGER_GRANT_DENYLIST.has(capabilityId) ||
      (!isProjectCapability && capabilityId !== CREATE_BOT_CAPABILITY)
    ) {
      throw new Error(`capability ${capabilityId} may not be granted to a project manager.`);
    }
    return { capabilityId, maxTier: grant.maxTier };
  });
}

export interface ProjectCharterInput {
  boundaries?: string;
  checkWithMeBefore?: string;
}

/** Fact keys of the charter (spec §1.2), scope='project' tier='profile'. */
export const PROJECT_CHARTER_SOURCE = "project:charter";
export const projectCharterKeys = {
  goal: "charter.goal",
  doneCriterion: "charter.done_criterion",
  boundaries: "charter.boundaries",
  checkWithMeBefore: "charter.check_with_me_before",
} as const;

export interface ProjectRosterInput {
  roleId: string;
  responsibility?: string;
  isManager?: boolean;
}

export interface NewProjectWithRoster {
  tenantId: string;
  name: string;
  goal: string;
  doneCriterion: string;
  charter?: ProjectCharterInput;
  budgetUsd?: number | null;
  createdBy: string;
  title?: string;
  roster: readonly ProjectRosterInput[];
  managerGrants?: readonly ManagerGrantInput[];
}

export interface ProjectWithRoster {
  project: Project;
  roster: ProjectRoleMember[];
}

interface TxClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

async function assertRolesInTenant(
  client: TxClient,
  tenantId: string,
  roleIds: readonly string[],
): Promise<void> {
  if (roleIds.length === 0) return;
  const found = await client.query(
    "SELECT role_id FROM roles WHERE tenant_id = $1 AND status = 'active' AND role_id = ANY($2::text[])",
    [tenantId, [...roleIds]],
  );
  if (found.rows.length !== new Set(roleIds).size) {
    throw new Error("every roster role must be an active role of this tenant.");
  }
}

async function writeCharterFacts(
  client: TxClient,
  input: {
    tenantId: string;
    projectId: string;
    goal: string;
    doneCriterion: string;
    charter: ProjectCharterInput;
    visibleTo: readonly string[];
  },
): Promise<void> {
  const entries: Array<[string, string]> = [
    [projectCharterKeys.goal, input.goal],
    [projectCharterKeys.doneCriterion, input.doneCriterion],
  ];
  const boundaries = input.charter.boundaries?.trim() ?? "";
  if (boundaries.length > 0) entries.push([projectCharterKeys.boundaries, boundaries]);
  const checkWithMe = input.charter.checkWithMeBefore?.trim() ?? "";
  if (checkWithMe.length > 0) entries.push([projectCharterKeys.checkWithMeBefore, checkWithMe]);
  for (const [key, value] of entries) {
    // Same row shape @oikonomos/memory writeMemoryFact writes (packages/db
    // cannot import it: dependency direction), inside the caller's tx so
    // the charter rolls back with the project.
    await client.query(
      `INSERT INTO profile_facts (tenant_id, scope, role_id, project_id, key, value, source, confidence, tier, expires_at, visible_to)
       VALUES ($1, 'project', NULL, $2, $3, $4, $5, 1.0, 'profile', NULL, $6)`,
      [input.tenantId, input.projectId, key, value, PROJECT_CHARTER_SOURCE, [...input.visibleTo]],
    );
  }
}

async function grantManager(
  client: TxClient,
  roleId: string,
  grants: readonly ManagerGrantInput[],
): Promise<void> {
  for (const grant of grants) {
    await client.query(
      `INSERT INTO role_grants (role_id, capability_id, max_tier, constraints) VALUES ($1, $2, $3, '{}')
       ON CONFLICT (role_id, capability_id) DO UPDATE SET max_tier = EXCLUDED.max_tier`,
      [roleId, grant.capabilityId, grant.maxTier],
    );
  }
}

/**
 * Demotion (ADR-019 Amendment 2026-09-19 (b), TASK-310 finding 3): revoke
 * the manager grants AND invalidate every still-live `workspace.create_bot`
 * approval issued to the role, in the caller's transaction. Approvals bind
 * only the action digest and a nonce, not manager state, so a stale approval
 * would otherwise stay human-grantable. The UPDATE mirrors
 * `INVALIDATE_PENDING_APPROVAL_SQL` (status guard, consumed_at untouched)
 * and also covers `granted`-but-unconsumed rows, the same hole one step on.
 * A role that still manages another project keeps its grants.
 */
async function demoteManagerInTx(
  client: TxClient,
  roleId: string,
  exceptProjectId: string,
): Promise<void> {
  const other = await client.query(
    "SELECT 1 FROM project_roles WHERE role_id = $1 AND is_manager AND project_id <> $2 LIMIT 1",
    [roleId, exceptProjectId],
  );
  if ((other.rowCount ?? 0) > 0) return;
  await client.query(
    `DELETE FROM role_grants WHERE role_id = $1
       AND (capability_id LIKE 'project.%' OR capability_id = $2)`,
    [roleId, CREATE_BOT_CAPABILITY],
  );
  await client.query(
    `UPDATE approvals SET status = 'invalidated'
      WHERE capability_id = $2 AND consumed_at IS NULL AND status IN ('pending', 'granted')
        AND run_id IN (SELECT r.run_id FROM runs r JOIN tasks t ON t.task_id = r.task_id WHERE t.role_id = $1)`,
    [roleId, CREATE_BOT_CAPABILITY],
  );
}

function normalizeRoster(roster: readonly ProjectRosterInput[]): Required<ProjectRosterInput>[] {
  const normalized = roster.map((member) => ({
    roleId: requireNonEmpty(member.roleId, "roleId"),
    responsibility: member.responsibility ?? "",
    isManager: member.isManager ?? false,
  }));
  if (new Set(normalized.map((member) => member.roleId)).size !== normalized.length) {
    throw new Error("roster must not contain duplicates.");
  }
  if (normalized.filter((member) => member.isManager).length > 1) {
    throw new Error("a project has at most one manager.");
  }
  return normalized;
}

/**
 * POST /projects storage (spec §2.2, §11 bullet 1): the group thread (same
 * INSERTs as `createGroupThread`), `thread_members`, the `projects` row,
 * `project_roles`, the charter facts and, if a manager is chosen, its
 * grants, all in ONE transaction: any failure leaves none of it behind.
 */
export async function createProjectWithRoster(
  options: DatabaseOptions,
  input: NewProjectWithRoster,
): Promise<ProjectWithRoster> {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const name = requireNonEmpty(input.name, "name");
  const goal = requireNonEmpty(input.goal, "goal");
  const doneCriterion = requireNonEmpty(input.doneCriterion, "doneCriterion");
  const createdBy = requireNonEmpty(input.createdBy, "createdBy");
  const roster = normalizeRoster(input.roster);
  if (roster.length < 2) throw new Error("a project roster needs at least two roles.");
  if (roster.length > PROJECT_ROSTER_CAP) {
    throw new Error(`a project roster supports at most ${PROJECT_ROSTER_CAP} members.`);
  }
  const grants = requireManagerGrants(input.managerGrants ?? []);
  const manager = roster.find((member) => member.isManager);
  if (manager === undefined && grants.length > 0) throw new Error("manager grants require a manager.");
  const budgetUsd = input.budgetUsd ?? null;
  const title = input.title === undefined ? name : requireNonEmpty(input.title, "title");

  return withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assertRolesInTenant(client, tenantId, roster.map((member) => member.roleId));
      const thread = await client.query(
        "INSERT INTO threads (role_id, title) VALUES (NULL, $1) RETURNING id",
        [title],
      );
      const threadId = thread.rows[0]?.id as string | undefined;
      if (threadId === undefined) throw new Error("createProjectWithRoster did not create a thread.");
      for (const member of roster) {
        await client.query("INSERT INTO thread_members (thread_id, role_id) VALUES ($1, $2)", [
          threadId,
          member.roleId,
        ]);
      }
      const projectResult = await client.query(
        `INSERT INTO projects (tenant_id, thread_id, name, goal, done_criterion, budget_usd, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${projectColumns}`,
        [tenantId, threadId, name, goal, doneCriterion, budgetUsd, createdBy],
      );
      const projectRow = projectResult.rows[0] as ProjectRow | undefined;
      if (projectRow === undefined) throw new Error("createProjectWithRoster did not return a project.");
      const members: ProjectRoleMember[] = [];
      for (const member of roster) {
        const inserted = await client.query(
          `INSERT INTO project_roles (project_id, role_id, is_manager, responsibility)
           VALUES ($1, $2, $3, $4) RETURNING ${projectRoleColumns}`,
          [projectRow.project_id, member.roleId, member.isManager, member.responsibility],
        );
        const row = inserted.rows[0] as ProjectRoleRow | undefined;
        if (row === undefined) throw new Error("createProjectWithRoster did not return a roster row.");
        members.push(toProjectRoleMember(row));
      }
      await writeCharterFacts(client, {
        tenantId,
        projectId: projectRow.project_id,
        goal,
        doneCriterion,
        charter: input.charter ?? {},
        visibleTo: roster.map((member) => member.roleId),
      });
      if (manager !== undefined) await grantManager(client, manager.roleId, grants);
      await client.query("COMMIT");
      return { project: toProject(projectRow), roster: members };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export interface ProjectUpdate {
  projectId: string;
  status?: ProjectStatus;
  budgetUsd?: number | null;
  addMembers?: readonly ProjectRosterInput[];
  removeRoleIds?: readonly string[];
  /** undefined = unchanged; null = the human manages; a role id = that role. */
  managerRoleId?: string | null;
  managerGrants?: readonly ManagerGrantInput[];
}

/**
 * PATCH /projects/:id storage: status, budget and roster/manager in one
 * transaction. Returns null when the project does not exist. A role that
 * stops being the manager (demoted, or removed from the roster) has its
 * grants revoked and its live `workspace.create_bot` approvals invalidated
 * in the same transaction.
 */
export async function updateProjectWithRoster(
  options: DatabaseOptions,
  input: ProjectUpdate,
): Promise<ProjectWithRoster | null> {
  const projectId = requireUuid(input.projectId, "projectId");
  const status = input.status === undefined ? undefined : oneOf(projectStatuses, input.status, "status");
  const additions = normalizeRoster(input.addMembers ?? []);
  const removals = (input.removeRoleIds ?? []).map((roleId) => requireNonEmpty(roleId, "roleId"));
  const grants = requireManagerGrants(input.managerGrants ?? []);
  const managerRoleId =
    input.managerRoleId === undefined || input.managerRoleId === null
      ? input.managerRoleId
      : requireNonEmpty(input.managerRoleId, "managerRoleId");

  return withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT ${projectColumns} FROM projects WHERE project_id = $1 FOR UPDATE`,
        [projectId],
      );
      const current = locked.rows[0] as ProjectRow | undefined;
      if (current === undefined) {
        await client.query("ROLLBACK");
        return null;
      }
      const threadId = current.thread_id;
      const before = await client.query(
        `SELECT ${projectRoleColumns} FROM project_roles WHERE project_id = $1`,
        [projectId],
      );
      const beforeRows = before.rows as ProjectRoleRow[];
      const oldManager = beforeRows.find((row) => row.is_manager)?.role_id ?? null;
      const roster = new Set(beforeRows.map((row) => row.role_id));

      await assertRolesInTenant(
        client,
        current.tenant_id,
        additions.map((member) => member.roleId).filter((roleId) => !roster.has(roleId)),
      );
      for (const roleId of removals) {
        await client.query("DELETE FROM project_roles WHERE project_id = $1 AND role_id = $2", [projectId, roleId]);
        await client.query("DELETE FROM thread_members WHERE thread_id = $1 AND role_id = $2", [threadId, roleId]);
        roster.delete(roleId);
      }
      for (const member of additions) {
        roster.add(member.roleId);
        if (roster.size > PROJECT_ROSTER_CAP) {
          throw new Error(`a project roster supports at most ${PROJECT_ROSTER_CAP} members.`);
        }
        await client.query(
          "INSERT INTO thread_members (thread_id, role_id) VALUES ($1, $2) ON CONFLICT (thread_id, role_id) DO NOTHING",
          [threadId, member.roleId],
        );
        await client.query(
          `INSERT INTO project_roles (project_id, role_id, is_manager, responsibility)
           VALUES ($1, $2, false, $3)
           ON CONFLICT (project_id, role_id) DO UPDATE SET responsibility = EXCLUDED.responsibility`,
          [projectId, member.roleId, member.responsibility],
        );
      }

      let newManager = oldManager;
      if (oldManager !== null && removals.includes(oldManager)) newManager = null;
      if (managerRoleId !== undefined) newManager = managerRoleId;
      if (newManager !== null && !roster.has(newManager)) {
        throw new Error(`role ${newManager} is not on the roster of project ${projectId}.`);
      }
      if (newManager !== oldManager) {
        await client.query("UPDATE project_roles SET is_manager = false WHERE project_id = $1 AND is_manager", [projectId]);
        if (oldManager !== null) await demoteManagerInTx(client, oldManager, projectId);
        if (newManager !== null) {
          await client.query("UPDATE project_roles SET is_manager = true WHERE project_id = $1 AND role_id = $2", [
            projectId,
            newManager,
          ]);
          await grantManager(client, newManager, grants);
        }
      }

      // Keep the charter's ACL equal to the roster: members see it, no one else.
      await client.query(
        `UPDATE profile_facts SET visible_to = $3
          WHERE tenant_id = $1 AND scope = 'project' AND project_id = $2 AND source = $4 AND superseded_by IS NULL`,
        [current.tenant_id, projectId, [...roster], PROJECT_CHARTER_SOURCE],
      );
      const updated = await client.query(
        `UPDATE projects SET status = COALESCE($2, status),
                budget_usd = CASE WHEN $3::boolean THEN $4::numeric ELSE budget_usd END,
                updated_at = now()
          WHERE project_id = $1 RETURNING ${projectColumns}`,
        [projectId, status ?? null, input.budgetUsd !== undefined, input.budgetUsd ?? null],
      );
      const members = await client.query(
        `SELECT ${projectRoleColumns} FROM project_roles WHERE project_id = $1 ORDER BY role_id`,
        [projectId],
      );
      await client.query("COMMIT");
      const row = updated.rows[0] as ProjectRow | undefined;
      if (row === undefined) throw new Error("updateProjectWithRoster lost the project row.");
      return { project: toProject(row), roster: (members.rows as ProjectRoleRow[]).map(toProjectRoleMember) };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export interface ProjectOverview {
  charter: Record<string, string>;
  roster: ProjectRoleMember[];
  taskCounts: Record<ProjectTaskState, number>;
  spendUsd: number;
}

/** GET /projects/:id extras (spec §9.1): charter, roster, board counts, spend. */
export async function getProjectOverview(
  options: DatabaseOptions,
  input: { tenantId: string; projectId: string },
): Promise<ProjectOverview> {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const projectId = requireUuid(input.projectId, "projectId");
  return withPool(options, async (pool) => {
    const [facts, roster, counts, spend] = await Promise.all([
      pool.query<{ key: string; value: string }>(
        `SELECT key, value FROM profile_facts
          WHERE tenant_id = $1 AND scope = 'project' AND project_id = $2 AND source = $3 AND superseded_by IS NULL`,
        [tenantId, projectId, PROJECT_CHARTER_SOURCE],
      ),
      pool.query<ProjectRoleRow>(
        `SELECT ${projectRoleColumns} FROM project_roles WHERE project_id = $1 ORDER BY role_id`,
        [projectId],
      ),
      pool.query<{ state: ProjectTaskState; n: string }>(
        "SELECT state, count(*) AS n FROM project_tasks WHERE project_id = $1 GROUP BY state",
        [projectId],
      ),
      pool.query<{ total: string | null }>(
        "SELECT sum(cost_usd) AS total FROM spend_records WHERE tenant_id = $1 AND project_id = $2",
        [tenantId, projectId],
      ),
    ]);
    const taskCounts = Object.fromEntries(projectTaskStates.map((state) => [state, 0])) as Record<
      ProjectTaskState,
      number
    >;
    for (const row of counts.rows) taskCounts[row.state] = Number(row.n);
    return {
      charter: Object.fromEntries(facts.rows.map((row) => [row.key, row.value])),
      roster: roster.rows.map(toProjectRoleMember),
      taskCounts,
      spendUsd: Number(spend.rows[0]?.total ?? 0),
    };
  });
}

/**
 * Spec §8.1: an approval decided on a run attributed to a project is
 * mirrored into `project_decisions` BY REFERENCE (`approval_id`), never by
 * copying the action render. A run is attributed through `project_task_runs`
 * (a work item linked to it) or `spend_records.project_id`. Idempotent per
 * (project, approval). Returns the number of projects mirrored to.
 */
export async function mirrorApprovalDecisionToProjects(
  options: DatabaseOptions,
  input: { nonce: string; decision: string; decidedBy: string },
): Promise<number> {
  const nonce = requireUuid(input.nonce, "nonce");
  const decision = requireNonEmpty(input.decision, "decision");
  const decidedBy = requireNonEmpty(input.decidedBy, "decidedBy");
  return withPool(options, async (pool) => {
    const result = await pool.query(
      `WITH a AS (SELECT approval_id, run_id, capability_id FROM approvals WHERE nonce = $1),
       attributed AS (
         SELECT pt.project_id, pt.task_id FROM a
           JOIN project_task_runs ptr ON ptr.run_id = a.run_id
           JOIN project_tasks pt ON pt.task_id = ptr.task_id
         UNION
         SELECT p.project_id, NULL::uuid FROM a
           JOIN spend_records s ON s.run_id = a.run_id::text AND s.project_id IS NOT NULL
           JOIN projects p ON p.project_id::text = s.project_id
       ), one AS (SELECT DISTINCT ON (project_id) project_id, task_id FROM attributed ORDER BY project_id, task_id NULLS LAST)
       INSERT INTO project_decisions (project_id, task_id, kind, approval_id, summary, actor)
       SELECT one.project_id, one.task_id, 'approval', a.approval_id,
              'approval ' || $2::text || ' for ' || a.capability_id, $3
         FROM one, a
        WHERE NOT EXISTS (
          SELECT 1 FROM project_decisions d WHERE d.project_id = one.project_id AND d.approval_id = a.approval_id)`,
      [nonce, decision, decidedBy],
    );
    return result.rowCount ?? 0;
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/db projects — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        createProject(options, {
          tenantId: "basileia",
          threadId: "11111111-1111-1111-1111-111111111111",
          name: "P",
          goal: "g",
          doneCriterion: "d",
          createdBy: "human:1",
        }),
      ).rejects.toThrow(/connectionString/);
    });

    it("rejects a malformed threadId on createProject", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createProject(live, {
          tenantId: "t",
          threadId: "not-a-uuid",
          name: "P",
          goal: "g",
          doneCriterion: "d",
          createdBy: "human:1",
        }),
      ).rejects.toThrow(/threadId/);
    });

    it("rejects an invalid status on createProject/listProjects/updateProjectStatus", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createProject(live, {
          tenantId: "t",
          threadId: "11111111-1111-1111-1111-111111111111",
          name: "P",
          goal: "g",
          doneCriterion: "d",
          createdBy: "human:1",
          status: "deleted" as ProjectStatus,
        }),
      ).rejects.toThrow(/status/);
      await expect(
        listProjects(live, { tenantId: "t", status: "deleted" as ProjectStatus }),
      ).rejects.toThrow(/status/);
      await expect(
        updateProjectStatus(live, "11111111-1111-1111-1111-111111111111", "deleted" as ProjectStatus),
      ).rejects.toThrow(/status/);
    });

    it("requires a non-empty blockedReason when transitioning a task to blocked", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        updateProjectTaskState(live, "11111111-1111-1111-1111-111111111111", "blocked"),
      ).rejects.toThrow(/blockedReason/);
    });

    it("rejects an invalid state/kind on the relevant functions", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        listProjectTasks(live, { projectId: "11111111-1111-1111-1111-111111111111", state: "archived" as ProjectTaskState }),
      ).rejects.toThrow(/state/);
      await expect(
        createProjectArtifact(live, {
          projectId: "11111111-1111-1111-1111-111111111111",
          kind: "url" as ProjectArtifactKind,
          ref: "x",
          label: "l",
        }),
      ).rejects.toThrow(/kind/);
      await expect(
        createProjectDecision(live, {
          projectId: "11111111-1111-1111-1111-111111111111",
          kind: "vote" as ProjectDecisionKind,
          summary: "s",
          actor: "human:1",
        }),
      ).rejects.toThrow(/kind/);
    });

    it("rejects a negative byteSize on createProjectArtifact", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createProjectArtifact(live, {
          projectId: "11111111-1111-1111-1111-111111111111",
          kind: "workspace_file",
          ref: "x",
          label: "l",
          byteSize: -1,
        }),
      ).rejects.toThrow(/byteSize/);
    });
  });
}

/**
 * Real Postgres-backed CRUD + FK tests, in-source rather than a separate
 * `projects.test.ts` (Owned_Paths for TASK-276 names this file, not a
 * sibling test file — see this task's dossier). Skipped entirely when
 * `DATABASE_URL` is unset, same gate `roles.test.ts` uses.
 */
/**
 * Real Postgres-backed CRUD + FK tests, in-source rather than a separate
 * `projects.test.ts` (Owned_Paths for TASK-276 names this file, not a
 * sibling test file — see this task's dossier). Skipped entirely when
 * `DATABASE_URL` is unset, same gate `roles.test.ts` uses. Uses `withPool`
 * (the shared-pool accessor, already imported above) for raw
 * fixture/cleanup queries rather than constructing a dedicated pg client
 * of its own — `database.test.ts`'s TASK-199 liveness check (accessor
 * modules must not construct their own pool) correctly rejects any
 * non-`.test.ts` file that does, and this file is a real accessor module,
 * not a test file exempted from that rule.
 */
if (import.meta.vitest) {
  const { describe, it, expect, beforeAll, afterAll } = import.meta.vitest;

  const connectionString = process.env.DATABASE_URL;
  const integration = connectionString === undefined ? describe.skip : describe;
  const dbOptions: DatabaseOptions = { connectionString: connectionString ?? "" };

  integration("@oikonomos/db projects — real Postgres CRUD + FK (TASK-276)", () => {
    const tenantId = "task-276-projects-suite";
    const rolePrefix = "task-276-projects-suite-role-";
    const roleId = `${rolePrefix}${randomUUID()}`;
    let threadId: string;

    /**
     * `threads.role_id` is UNIQUE — each project under test needs its own
     * real thread (a NOT NULL FK target, `projects.thread_id REFERENCES
     * threads(id)`), so this mints a fresh role+thread pair per call rather
     * than reusing one or fabricating an unbacked UUID that would just trip
     * the FK constraint instead of testing intended behavior.
     */
    async function makeThread(): Promise<string> {
      const fixtureRoleId = `${rolePrefix}${randomUUID()}`;
      return withPool(dbOptions, async (pool) => {
        await pool.query(
          `INSERT INTO roles (role_id, tenant_id, name, title) VALUES ($1, $2, 'Projects Suite Fixture Role', 'Projects Suite Fixture Role')`,
          [fixtureRoleId, tenantId],
        );
        const threadResult = await pool.query<{ id: string }>(
          `INSERT INTO threads (role_id, title) VALUES ($1, 'Projects Suite Fixture Thread') RETURNING id`,
          [fixtureRoleId],
        );
        return threadResult.rows[0]!.id;
      });
    }

    async function cleanup(): Promise<void> {
      await withPool(dbOptions, async (pool) => {
        await pool.query(
          `DELETE FROM project_decisions WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)`,
          [tenantId],
        );
        await pool.query(
          `DELETE FROM project_artifacts WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)`,
          [tenantId],
        );
        await pool.query(
          `DELETE FROM project_tasks WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)`,
          [tenantId],
        );
        await pool.query(`DELETE FROM projects WHERE tenant_id = $1`, [tenantId]);
        await pool.query(`DELETE FROM threads WHERE role_id LIKE $1`, [`${rolePrefix}%`]);
        await pool.query(`DELETE FROM roles WHERE role_id LIKE $1`, [`${rolePrefix}%`]);
      });
    }

    beforeAll(async () => {
      await cleanup();
      threadId = await withPool(dbOptions, async (pool) => {
        await pool.query(
          `INSERT INTO roles (role_id, tenant_id, name, title) VALUES ($1, $2, 'Projects Suite Role', 'Projects Suite Role')`,
          [roleId, tenantId],
        );
        const threadResult = await pool.query<{ id: string }>(
          `INSERT INTO threads (role_id, title) VALUES ($1, 'Projects Suite Thread') RETURNING id`,
          [roleId],
        );
        return threadResult.rows[0]!.id;
      });
    });

    afterAll(cleanup);

    it("creates a project bound to a real thread and reads it back byte-identical", async () => {
      const created = await createProject(
        { connectionString: connectionString! },
        { tenantId, threadId, name: "Project A", goal: "Ship it", doneCriterion: "Shipped", createdBy: "human:1" },
      );

      expect(created.status).toBe("active");
      expect(created.threadId).toBe(threadId);

      const fetched = await getProject({ connectionString: connectionString! }, created.projectId);
      expect(fetched).toEqual(created);

      const byThread = await getProjectByThreadId({ connectionString: connectionString! }, threadId);
      expect(byThread).toEqual(created);
    });

    it("enforces the thread_id UNIQUE constraint — a thread binds at most one project", async () => {
      await expect(
        createProject(
          { connectionString: connectionString! },
          { tenantId, threadId, name: "Project A Duplicate", goal: "g", doneCriterion: "d", createdBy: "human:1" },
        ),
      ).rejects.toThrow();
    });

    it("rejects a project_tasks insert whose projectId does not exist (FK enforcement)", async () => {
      await expect(
        createProjectTask(
          { connectionString: connectionString! },
          { projectId: "00000000-0000-0000-0000-000000000000", title: "orphan", createdBy: "human:1" },
        ),
      ).rejects.toThrow();
    });

    it("creates, lists, and transitions a project task; blocked requires a reason and clears on recovery", async () => {
      const project = await createProject(
        { connectionString: connectionString! },
        { tenantId, threadId: await makeThread(), name: "Project B", goal: "g", doneCriterion: "d", createdBy: "human:1" },
      );

      const task = await createProjectTask(
        { connectionString: connectionString! },
        { projectId: project.projectId, title: "Do the thing", ownerRoleId: roleId, createdBy: `role:${roleId}` },
      );
      expect(task.state).toBe("todo");
      expect(task.ownerRoleId).toBe(roleId);

      const fetched = await getProjectTask({ connectionString: connectionString! }, task.taskId);
      expect(fetched).toEqual(task);

      const listed = await listProjectTasks({ connectionString: connectionString! }, { projectId: project.projectId });
      expect(listed.map((t) => t.taskId)).toEqual([task.taskId]);

      const blocked = await updateProjectTaskState(
        { connectionString: connectionString! },
        task.taskId,
        "blocked",
        "waiting on upstream data",
      );
      expect(blocked?.state).toBe("blocked");
      expect(blocked?.blockedReason).toBe("waiting on upstream data");

      const recovered = await updateProjectTaskState({ connectionString: connectionString! }, task.taskId, "doing");
      expect(recovered?.state).toBe("doing");
      expect(recovered?.blockedReason).toBeNull();

      const onlyDoing = await listProjectTasks(
        { connectionString: connectionString! },
        { projectId: project.projectId, state: "doing" },
      );
      expect(onlyDoing.map((t) => t.taskId)).toEqual([task.taskId]);
    });

    it("rejects a blocked-state row at the database if blocked_reason is missing (CHECK constraint)", async () => {
      const project = await createProject(
        { connectionString: connectionString! },
        { tenantId, threadId: await makeThread(), name: "Project C", goal: "g", doneCriterion: "d", createdBy: "human:1" },
      );
      await expect(
        withPool(dbOptions, (pool) =>
          pool.query(`INSERT INTO project_tasks (project_id, title, state, created_by) VALUES ($1, 't', 'blocked', 'human:1')`, [
            project.projectId,
          ]),
        ),
      ).rejects.toThrow();
    });

    it("registers, reads, and lists an artifact linked to a project and task", async () => {
      const project = await createProject(
        { connectionString: connectionString! },
        { tenantId, threadId: await makeThread(), name: "Project D", goal: "g", doneCriterion: "d", createdBy: "human:1" },
      );
      const task = await createProjectTask(
        { connectionString: connectionString! },
        { projectId: project.projectId, title: "t", createdBy: "human:1" },
      );

      const artifact = await createProjectArtifact(
        { connectionString: connectionString! },
        {
          projectId: project.projectId,
          taskId: task.taskId,
          kind: "workspace_file",
          ref: `/oikonomos/workspace/projects/${project.projectId}/report.md`,
          sha256: "a".repeat(64),
          byteSize: 42,
          producedByRoleId: roleId,
          label: "STATUS.md",
        },
      );
      expect(artifact.kind).toBe("workspace_file");

      const fetched = await getProjectArtifact({ connectionString: connectionString! }, artifact.artifactId);
      expect(fetched).toEqual(artifact);

      const listed = await listProjectArtifacts(
        { connectionString: connectionString! },
        { projectId: project.projectId, taskId: task.taskId },
      );
      expect(listed.map((a) => a.artifactId)).toEqual([artifact.artifactId]);
    });

    it("rejects a project_artifacts insert whose projectId does not exist (FK enforcement)", async () => {
      await expect(
        createProjectArtifact(
          { connectionString: connectionString! },
          { projectId: "00000000-0000-0000-0000-000000000000", kind: "attachment", ref: "x", label: "l" },
        ),
      ).rejects.toThrow();
    });

    it("records and lists a decision by reference, and rejects an unknown approvalId (FK enforcement)", async () => {
      const project = await createProject(
        { connectionString: connectionString! },
        { tenantId, threadId: await makeThread(), name: "Project E", goal: "g", doneCriterion: "d", createdBy: "human:1" },
      );

      const decision = await createProjectDecision(
        { connectionString: connectionString! },
        { projectId: project.projectId, kind: "human_decision", summary: "Approved scope change", actor: "human:1" },
      );
      expect(decision.kind).toBe("human_decision");
      expect(decision.approvalId).toBeNull();

      const fetched = await getProjectDecision({ connectionString: connectionString! }, decision.decisionId);
      expect(fetched).toEqual(decision);

      const listed = await listProjectDecisions(
        { connectionString: connectionString! },
        { projectId: project.projectId },
      );
      expect(listed.map((d) => d.decisionId)).toEqual([decision.decisionId]);

      await expect(
        createProjectDecision(
          { connectionString: connectionString! },
          {
            projectId: project.projectId,
            kind: "approval",
            approvalId: "00000000-0000-0000-0000-000000000000",
            summary: "s",
            actor: "human:1",
          },
        ),
      ).rejects.toThrow();
    });
  });
}
