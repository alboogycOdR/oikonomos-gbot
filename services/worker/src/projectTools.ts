import {
  assignProjectTaskOwner, createProjectArtifact, createProjectDecision, createProjectTask,
  getProjectTask, listProjectRoleMembers, listProjectTasks, updateProjectTaskState,
  type NewProjectArtifact, type NewProjectDecision, type NewProjectTask, type ProjectRoleMember,
  type ProjectTask, type ProjectTaskState,
} from "@oikonomos/db";
import { recordAuditEvent } from "@oikonomos/audit";
import { resolveWorkspacePath, sendToRole } from "@oikonomos/workspace";

export const PROJECT_TOOL_NAMES = ["list_board", "create_task", "update_task", "assign_task", "register_artifact", "record_decision"] as const;
export type ProjectToolName = (typeof PROJECT_TOOL_NAMES)[number];

export interface ProjectToolIdentity { readonly connectionString: string; readonly tenantId: string; readonly fromRoleId: string; readonly runId?: string; }
export interface ProjectToolsDeps {
  listTasks(projectId: string): Promise<ProjectTask[]>;
  getTask(taskId: string): Promise<ProjectTask | null>;
  createTask(input: NewProjectTask): Promise<ProjectTask>;
  updateTask(taskId: string, state: ProjectTaskState, blockedReason?: string): Promise<ProjectTask | null>;
  assignOwner(taskId: string, ownerRoleId: string): Promise<ProjectTask | null>;
  members(projectId: string): Promise<ProjectRoleMember[]>;
  createArtifact(input: NewProjectArtifact): Promise<unknown>;
  createDecision(input: NewProjectDecision): Promise<unknown>;
  sendAssignment(input: { toRoleId: string; body: string; projectId: string; taskId: string }): Promise<unknown>;
  audit(eventType: string, payload: Record<string, unknown>): Promise<void>;
  resolvePath(ref: string): string;
}

export function createProjectTools(identity: ProjectToolIdentity, overrides: Partial<ProjectToolsDeps> = {}) {
  const db = { connectionString: identity.connectionString };
  const deps: ProjectToolsDeps = {
    listTasks: (projectId) => listProjectTasks(db, { projectId }),
    getTask: (taskId) => getProjectTask(db, taskId),
    createTask: (input) => createProjectTask(db, input),
    updateTask: (taskId, state, reason) => updateProjectTaskState(db, taskId, state, reason),
    assignOwner: (taskId, ownerRoleId) => assignProjectTaskOwner(db, taskId, ownerRoleId),
    members: (projectId) => listProjectRoleMembers(db, projectId),
    createArtifact: (input) => createProjectArtifact(db, input),
    createDecision: (input) => createProjectDecision(db, input),
    sendAssignment: ({ toRoleId, body, projectId, taskId }) => sendToRole(db, { tenantId: identity.tenantId, fromRoleId: identity.fromRoleId, toRoleId, body, handoffKind: "task.assigned", factRef: { project_id: projectId, task_id: taskId, artifact_ids: [] } }),
    audit: async (eventType, payload) => { await recordAuditEvent(db, { tenantId: identity.tenantId, runId: identity.runId, actor: `agent:${identity.fromRoleId}`, eventType, payload }); },
    resolvePath: projectWorkspacePath,
    ...overrides,
  };
  let assignments = 0;
  let assignmentQueue = Promise.resolve();
  const requireManager = async (projectId: string) => {
    const member = (await deps.members(projectId)).find((candidate) => candidate.roleId === identity.fromRoleId);
    if (member?.isManager !== true) throw new Error("Only the project's manager may use write tools.");
  };
  const actor = `role:${identity.fromRoleId}`;

  return {
    async list_board(args: Record<string, unknown>) { const projectId = stringArg(args, "projectId"); const tasks = await deps.listTasks(projectId); await deps.audit("project.board_listed", { project_id: projectId, actor }); return tasks; },
    async create_task(args: Record<string, unknown>) {
      const projectId = stringArg(args, "projectId"); await requireManager(projectId);
      const ownerRoleId = optionalString(args, "ownerRoleId");
      if (ownerRoleId !== undefined && !(await deps.members(projectId)).some((member) => member.roleId === ownerRoleId)) throw new Error("Task owner must be on the project roster.");
      const task = await deps.createTask({ projectId, title: stringArg(args, "title"), description: optionalString(args, "description"), ownerRoleId, doneCriterion: optionalString(args, "doneCriterion"), createdBy: actor });
      await deps.audit("project.task_created", { task_id: task.taskId, project_id: projectId, actor }); return task;
    },
    async update_task(args: Record<string, unknown>) {
      const task = await requiredTask(deps, stringArg(args, "taskId")); await requireManager(task.projectId);
      const to = stateArg(args, "state"); const reason = optionalString(args, "blockedReason");
      if (!legalTransition(task.state, to) || (to === "blocked" && (reason === undefined || reason.trim() === ""))) throw new Error("Illegal project task transition.");
      const updated = await deps.updateTask(task.taskId, to, reason); if (updated === null) throw new Error("Project task was not found.");
      await deps.audit("project.task_transition", { task_id: task.taskId, from: task.state, to, actor }); return updated;
    },
    async assign_task(args: Record<string, unknown>) {
      const taskId = stringArg(args, "taskId"); const ownerRoleId = stringArg(args, "ownerRoleId");
      const task = await requiredTask(deps, taskId); await requireManager(task.projectId);
      const roster = await deps.members(task.projectId);
      if (!roster.some((member) => member.roleId === ownerRoleId)) throw new Error("Task owner must be on the project roster.");
      const work = assignmentQueue.then(async () => {
        if (assignments >= roster.length) { await deps.audit("project.fanout_capped", { project_id: task.projectId, task_id: task.taskId, actor, roster_size: roster.length }); throw new Error("Project fan-out cap reached for this manager turn."); }
        const assigned = await deps.assignOwner(task.taskId, ownerRoleId); if (assigned === null) throw new Error("Project task was not found.");
        await deps.audit("project.task_assigned", { project_id: task.projectId, task_id: task.taskId, owner_role_id: ownerRoleId, actor });
        await deps.sendAssignment({ toRoleId: ownerRoleId, body: `You have been assigned: ${assigned.title}`, projectId: task.projectId, taskId: task.taskId });
        assignments += 1; return assigned;
      });
      assignmentQueue = work.then(() => undefined, () => undefined); return work;
    },
    async register_artifact(args: Record<string, unknown>) {
      const projectId = stringArg(args, "projectId"); await requireManager(projectId);
      const kind = stringArg(args, "kind"); const ref = stringArg(args, "ref");
      if (kind === "workspace_file" && (!ref.startsWith(`/oikonomos/workspace/projects/${projectId}/`) || deps.resolvePath(ref) !== ref)) throw new Error("workspace_file ref must be a canonical path under its project workspace.");
      const artifact = await deps.createArtifact({ projectId, taskId: optionalString(args, "taskId"), kind: kind as NewProjectArtifact["kind"], ref, sha256: optionalString(args, "sha256"), byteSize: optionalInteger(args, "byteSize"), producedByRoleId: identity.fromRoleId, producedByRunId: identity.runId, label: stringArg(args, "label") });
      await deps.audit("project.artifact_registered", { project_id: projectId, kind, ref, actor }); return artifact;
    },
    async record_decision(args: Record<string, unknown>) {
      const projectId = stringArg(args, "projectId"); await requireManager(projectId);
      const decision = await deps.createDecision({ projectId, taskId: optionalString(args, "taskId"), kind: stringArg(args, "kind") as NewProjectDecision["kind"], approvalId: optionalString(args, "approvalId"), summary: stringArg(args, "summary"), actor });
      await deps.audit("project.decision_recorded", { project_id: projectId, actor }); return decision;
    },
  } satisfies Record<ProjectToolName, (args: Record<string, unknown>) => Promise<unknown>>;
}

function projectWorkspacePath(ref: string): string { const prefix = "/oikonomos/workspace/projects/"; if (!ref.startsWith(prefix)) throw new Error("workspace_file ref must be under the project workspace."); return resolveWorkspacePath(ref.slice("/oikonomos/workspace/".length)).path; }
function stringArg(args: Record<string, unknown>, name: string): string { const value = args[name]; if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string.`); return value; }
function optionalString(args: Record<string, unknown>, name: string): string | undefined { const value = args[name]; if (value === undefined) return undefined; return stringArg(args, name); }
function optionalInteger(args: Record<string, unknown>, name: string): number | undefined { const value = args[name]; if (value === undefined) return undefined; if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer.`); return value as number; }
function stateArg(args: Record<string, unknown>, name: string): ProjectTaskState { const state = stringArg(args, name); if (!["todo", "doing", "blocked", "review", "done", "cancelled"].includes(state)) throw new Error("Invalid project task state."); return state as ProjectTaskState; }
async function requiredTask(deps: ProjectToolsDeps, taskId: string): Promise<ProjectTask> { const task = await deps.getTask(taskId); if (task === null) throw new Error("Project task was not found."); return task; }
function legalTransition(from: ProjectTaskState, to: ProjectTaskState): boolean { return (from === "todo" && (to === "doing" || to === "cancelled")) || (from === "doing" && (to === "review" || to === "blocked" || to === "cancelled")) || (from === "blocked" && (to === "doing" || to === "cancelled")) || (from === "review" && (to === "done" || to === "cancelled")); }
