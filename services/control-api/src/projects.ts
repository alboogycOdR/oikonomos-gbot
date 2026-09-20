import { posix } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  projectArtifactKinds,
  projectStatuses,
  projectTaskStates,
  PROJECT_ROSTER_CAP,
  type GroupThread,
  type ManagerGrantInput,
  type Project,
  type ProjectArtifactKind,
  type ProjectStatus,
  type ProjectTask,
  type ProjectTaskState,
  type Thread,
} from "@oikonomos/db";

import { CronExpressionParser } from "cron-parser";

import {
  buildManagerCharter,
  STATUS_ROUTINE_NAME,
  STATUS_ROUTINE_SCHEDULE,
  statusRoutineDefinition,
} from "./charters/managerCharter.js";
import type { ControlApiDeps, ProjectPorts } from "./ports.js";

/**
 * TASK-304 (P-5) — the project workspace API, spec §9.1. Every route is
 * scoped to the caller's tenant through the SAME thread-ownership rule as
 * every other group-thread route (`findTenantOwnedThread`, injected by
 * app.ts so the rule has one implementation) and answers 404, never 403, for
 * a project that is missing or that belongs to someone else. Persistence goes
 * only through the `ProjectPorts` deps (no raw SQL in this package).
 */
export interface ProjectRouteOwnership {
  findOwnedThread(tenantId: string, threadId: string): Promise<Thread | GroupThread | undefined>;
  listOwnedThreads(tenantId: string): Promise<Array<Thread | GroupThread>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ADR-019 Amendment 2026-09-19 / spec §7.2a v1.3: never granted by this route. */
const MANAGER_EXCLUDED_CAPABILITIES = new Set(["project.request_grant", "project.create_role", "workspace.retire_bot"]);
const CREATE_BOT_CAPABILITY = "workspace.create_bot";

/** Spec §3.1: todo → doing → review → done; blocked from doing; cancelled from any non-done. */
const TASK_TRANSITIONS: Record<ProjectTaskState, readonly ProjectTaskState[]> = {
  todo: ["doing", "cancelled"],
  doing: ["review", "blocked", "cancelled"],
  blocked: ["doing", "cancelled"],
  review: ["done", "doing", "cancelled"],
  done: [],
  cancelled: [],
};

const ROSTER_MEMBER_SCHEMA = {
  type: "object",
  required: ["roleId"],
  additionalProperties: false,
  properties: {
    roleId: { type: "string", minLength: 1 },
    responsibility: { type: "string" },
    isManager: { type: "boolean" },
  },
} as const;

const CREATE_PROJECT_SCHEMA = {
  type: "object",
  required: ["name", "goal", "doneCriterion", "roster"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    doneCriterion: { type: "string", minLength: 1 },
    boundaries: { type: "string" },
    checkWithMeBefore: { type: "string" },
    budgetUsd: { type: ["number", "null"], minimum: 0 },
    roster: { type: "array", minItems: 2, maxItems: PROJECT_ROSTER_CAP, items: ROSTER_MEMBER_SCHEMA },
  },
} as const;

const PATCH_PROJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    status: { type: "string", enum: [...projectStatuses] },
    budgetUsd: { type: ["number", "null"], minimum: 0 },
    addMembers: { type: "array", maxItems: PROJECT_ROSTER_CAP, items: ROSTER_MEMBER_SCHEMA },
    removeRoleIds: { type: "array", maxItems: PROJECT_ROSTER_CAP, items: { type: "string", minLength: 1 } },
    managerRoleId: { type: ["string", "null"] },
  },
} as const;

const LIST_PROJECTS_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { status: { type: "string", enum: [...projectStatuses] } },
} as const;

const LIST_TASKS_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { state: { type: "string", enum: [...projectTaskStates] } },
} as const;

const CREATE_TASK_SCHEMA = {
  type: "object",
  required: ["title"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    ownerRoleId: { type: "string", minLength: 1 },
    doneCriterion: { type: "string" },
    state: { type: "string", enum: ["todo", "blocked"] },
    blockedReason: { type: "string" },
  },
} as const;

const PATCH_TASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    state: { type: "string", enum: [...projectTaskStates] },
    blockedReason: { type: "string" },
    ownerRoleId: { type: "string", minLength: 1 },
  },
} as const;

const CREATE_ARTIFACT_SCHEMA = {
  type: "object",
  required: ["kind", "ref", "label"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: [...projectArtifactKinds] },
    ref: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 },
    taskId: { type: "string" },
    sha256: { type: "string", minLength: 1 },
    byteSize: { type: "integer", minimum: 0 },
    producedByRoleId: { type: "string", minLength: 1 },
    producedByRunId: { type: "string" },
  },
} as const;

interface RosterMemberBody {
  roleId: string;
  responsibility?: string;
  isManager?: boolean;
}

function notFound(reply: FastifyReply): void {
  void reply.code(404).send({ error: "project not found" });
}

function badRequest(reply: FastifyReply, message: string): void {
  void reply.code(400).send({ error: message });
}

function isValidArtifactRef(projectId: string, kind: ProjectArtifactKind, ref: string): boolean {
  if (kind !== "workspace_file") return true;
  // Spec §4 / §11: a workspace_file artifact must be a canonical path inside
  // the project's own directory. The directory itself is created lazily by
  // the first writer (ORCH resolution of D1), never by this route.
  return ref.startsWith(`/oikonomos/workspace/projects/${projectId}/`) && posix.normalize(ref) === ref;
}

/**
 * The manager's grant set, resolved from the live capability registry so a
 * capability declared disabled (`project.request_grant`) can never be
 * granted by accident: exactly the enabled `project.*` capabilities plus
 * `workspace.create_bot`, never `workspace.retire_bot` (until TASK-313) and
 * never anything that writes grants.
 */
async function resolveManagerGrants(deps: ControlApiDeps): Promise<ManagerGrantInput[]> {
  const capabilities = await deps.listCapabilities();
  return capabilities
    .filter(
      (capability) =>
        capability.enabled &&
        !MANAGER_EXCLUDED_CAPABILITIES.has(capability.capabilityId) &&
        (capability.capabilityId.startsWith("project.") || capability.capabilityId === CREATE_BOT_CAPABILITY),
    )
    .map((capability) => ({ capabilityId: capability.capabilityId, maxTier: capability.defaultTier }));
}

/**
 * TASK-305 (P-6, spec §7.1/§1.3): seed the manager's instructions from the
 * charter and give it one changes_only status routine. Idempotent on the
 * routine (one per project). Failure is audited, not swallowed silently; the
 * project/roster write has already committed, so it must not turn into a 400.
 */
async function seedManager(
  deps: ControlApiDeps,
  tenantId: string,
  project: Project,
  managerRoleId: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<void> {
  try {
    await deps.updateRoleInstructions(
      managerRoleId,
      buildManagerCharter({ projectName: project.name, goal: project.goal, doneCriterion: project.doneCriterion }),
    );
    const existing = await deps.listRoutines({ tenantId, roleId: managerRoleId });
    const has = existing.some((routine) => routine.definition?.["projectId"] === project.projectId);
    if (!has) {
      await deps.createRoutine({
        roleId: managerRoleId,
        tenantId,
        name: STATUS_ROUTINE_NAME,
        schedule: STATUS_ROUTINE_SCHEDULE,
        definition: statusRoutineDefinition(project.projectId),
        notifyThreshold: "changes_only",
        nextFireAt: CronExpressionParser.parse(STATUS_ROUTINE_SCHEDULE, { tz: "UTC" }).next().toDate(),
      });
    }
    await audit(deps, tenantId, "project.manager_seeded", {
      project_id: project.projectId,
      manager_role_id: managerRoleId,
      status_routine_created: !has,
    });
  } catch (error) {
    log.warn({ err: error }, "Manager seeding failed");
    await audit(deps, tenantId, "project.manager_seed_failed", {
      project_id: project.projectId,
      manager_role_id: managerRoleId,
      error: (error as Error).message,
    });
  }
}

async function audit(
  deps: ControlApiDeps,
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (deps.insertAuditEvent === undefined) return;
  await deps.insertAuditEvent({ tenantId, actor: `human:${tenantId}`, eventType, payload });
}

function serializeProject(project: Project) {
  return {
    projectId: project.projectId,
    threadId: project.threadId,
    name: project.name,
    goal: project.goal,
    doneCriterion: project.doneCriterion,
    status: project.status,
    budgetUsd: project.budgetUsd,
    createdBy: project.createdBy,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function serializeTask(task: ProjectTask) {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    ownerRoleId: task.ownerRoleId,
    state: task.state,
    blockedReason: task.blockedReason,
    doneCriterion: task.doneCriterion,
    createdBy: task.createdBy,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function registerProjectRoutes(
  app: FastifyInstance,
  deps: ControlApiDeps,
  ownership: ProjectRouteOwnership,
): void {
  /** The project port, or a 501 reply when this deployment has none. */
  function ports(reply: FastifyReply): ProjectPorts | undefined {
    if (deps.projects === undefined) {
      void reply.code(501).send({ error: "projects are not configured" });
      return undefined;
    }
    return deps.projects;
  }

  /** The caller's own project, or a 404 reply (never 403) for anything else. */
  async function ownedProject(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    port: ProjectPorts,
  ): Promise<Project | undefined> {
    const projectId = request.params.id;
    if (!UUID_RE.test(projectId)) {
      notFound(reply);
      return undefined;
    }
    const project = await port.getProject(projectId);
    if (
      project === null ||
      project.tenantId !== request.tenantId ||
      (await ownership.findOwnedThread(request.tenantId, project.threadId)) === undefined
    ) {
      notFound(reply);
      return undefined;
    }
    return project;
  }

  app.post<{
    Body: {
      name: string;
      goal: string;
      doneCriterion: string;
      boundaries?: string;
      checkWithMeBefore?: string;
      budgetUsd?: number | null;
      roster: RosterMemberBody[];
    };
  }>("/projects", { schema: { body: CREATE_PROJECT_SCHEMA } }, async (request, reply) => {
    const port = ports(reply);
    if (port === undefined) return;
    try {
      const { roster } = request.body;
      const manager = roster.find((member) => member.isManager === true);
      if (roster.filter((member) => member.isManager === true).length > 1) {
        badRequest(reply, "a project has at most one manager.");
        return;
      }
      const created = await port.createProject({
        tenantId: request.tenantId,
        name: request.body.name.trim(),
        goal: request.body.goal.trim(),
        doneCriterion: request.body.doneCriterion.trim(),
        charter: {
          ...(request.body.boundaries === undefined ? {} : { boundaries: request.body.boundaries }),
          ...(request.body.checkWithMeBefore === undefined ? {} : { checkWithMeBefore: request.body.checkWithMeBefore }),
        },
        ...(request.body.budgetUsd === undefined ? {} : { budgetUsd: request.body.budgetUsd }),
        createdBy: `human:${request.tenantId}`,
        roster,
        managerGrants: manager === undefined ? [] : await resolveManagerGrants(deps),
      });
      await audit(deps, request.tenantId, "project.created", {
        project_id: created.project.projectId,
        thread_id: created.project.threadId,
        roster: created.roster.map((member) => member.roleId),
        manager_role_id: manager?.roleId ?? null,
      });
      if (manager !== undefined) {
        await seedManager(deps, request.tenantId, created.project, manager.roleId, request.log);
      }
      await reply.code(201).send({ project: serializeProject(created.project), roster: created.roster });
    } catch (error) {
      request.log.warn({ err: error }, "Project create failed");
      badRequest(reply, (error as Error).message);
    }
  });

  app.get<{ Querystring: { status?: ProjectStatus } }>(
    "/projects",
    { schema: { querystring: LIST_PROJECTS_QUERY_SCHEMA } },
    async (request, reply) => {
      const port = ports(reply);
      if (port === undefined) return;
      try {
        const [projects, threads] = await Promise.all([
          port.listProjects({
            tenantId: request.tenantId,
            ...(request.query.status === undefined ? {} : { status: request.query.status }),
          }),
          ownership.listOwnedThreads(request.tenantId),
        ]);
        const ownedThreadIds = new Set(threads.map((thread) => thread.id));
        await reply
          .code(200)
          .send(projects.filter((project) => ownedThreadIds.has(project.threadId)).map(serializeProject));
      } catch (error) {
        badRequest(reply, (error as Error).message);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const port = ports(reply);
    if (port === undefined) return;
    try {
      const project = await ownedProject(request, reply, port);
      if (project === undefined) return;
      const [overview, artifacts] = await Promise.all([
        port.getOverview({ tenantId: request.tenantId, projectId: project.projectId }),
        port.listArtifacts({ projectId: project.projectId }),
      ]);
      // Spec §1.4: the project's status is an artifact named STATUS.md,
      // registered with provenance; list order is newest first.
      const latestStatus = artifacts.find(
        (artifact) => artifact.ref.split("/").pop() === "STATUS.md" || artifact.label === "STATUS.md",
      );
      await reply.code(200).send({
        ...serializeProject(project),
        charter: overview.charter,
        roster: overview.roster,
        board: overview.taskCounts,
        latestStatusArtifact:
          latestStatus === undefined
            ? null
            : { ...latestStatus, createdAt: latestStatus.createdAt.toISOString() },
        spend: { usd: overview.spendUsd, budgetUsd: project.budgetUsd },
      });
    } catch (error) {
      badRequest(reply, (error as Error).message);
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      status?: ProjectStatus;
      budgetUsd?: number | null;
      addMembers?: RosterMemberBody[];
      removeRoleIds?: string[];
      managerRoleId?: string | null;
    };
  }>("/projects/:id", { schema: { body: PATCH_PROJECT_SCHEMA } }, async (request, reply) => {
    const port = ports(reply);
    if (port === undefined) return;
    try {
      const project = await ownedProject(request, reply, port);
      if (project === undefined) return;
      const body = request.body;
      const updated = await port.updateProject({
        projectId: project.projectId,
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.budgetUsd === undefined ? {} : { budgetUsd: body.budgetUsd }),
        ...(body.addMembers === undefined ? {} : { addMembers: body.addMembers.map((member) => ({ ...member, isManager: false })) }),
        ...(body.removeRoleIds === undefined ? {} : { removeRoleIds: body.removeRoleIds }),
        ...(body.managerRoleId === undefined ? {} : { managerRoleId: body.managerRoleId }),
        managerGrants: typeof body.managerRoleId === "string" ? await resolveManagerGrants(deps) : [],
      });
      if (updated === null) {
        notFound(reply);
        return;
      }
      await audit(deps, request.tenantId, "project.updated", {
        project_id: project.projectId,
        changed: Object.keys(body),
        manager_role_id: updated.roster.find((member) => member.isManager)?.roleId ?? null,
      });
      if (typeof body.managerRoleId === "string") {
        await seedManager(deps, request.tenantId, updated.project, body.managerRoleId, request.log);
      }
      await reply.code(200).send({ project: serializeProject(updated.project), roster: updated.roster });
    } catch (error) {
      request.log.warn({ err: error }, "Project update failed");
      badRequest(reply, (error as Error).message);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { state?: ProjectTaskState } }>(
    "/projects/:id/tasks",
    { schema: { querystring: LIST_TASKS_QUERY_SCHEMA } },
    async (request, reply) => {
      const port = ports(reply);
      if (port === undefined) return;
      try {
        const project = await ownedProject(request, reply, port);
        if (project === undefined) return;
        const tasks = await port.listTasks({
          projectId: project.projectId,
          ...(request.query.state === undefined ? {} : { state: request.query.state }),
        });
        await reply.code(200).send(tasks.map(serializeTask));
      } catch (error) {
        badRequest(reply, (error as Error).message);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      title: string;
      description?: string;
      ownerRoleId?: string;
      doneCriterion?: string;
      state?: "todo" | "blocked";
      blockedReason?: string;
    };
  }>("/projects/:id/tasks", { schema: { body: CREATE_TASK_SCHEMA } }, async (request, reply) => {
    const port = ports(reply);
    if (port === undefined) return;
    try {
      const project = await ownedProject(request, reply, port);
      if (project === undefined) return;
      const body = request.body;
      const state = body.state ?? "todo";
      if (state === "blocked" && (body.blockedReason ?? "").trim().length === 0) {
        badRequest(reply, "a blocked work item requires a blockedReason.");
        return;
      }
      if (state !== "blocked" && body.blockedReason !== undefined) {
        badRequest(reply, "blockedReason is only valid for a blocked work item.");
        return;
      }
      if (body.ownerRoleId !== undefined) {
        const roster = await port.listRoster(project.projectId);
        if (!roster.some((member) => member.roleId === body.ownerRoleId)) {
          badRequest(reply, "a work item's owner must be on the project roster.");
          return;
        }
      }
      const task = await port.createTask({
        projectId: project.projectId,
        title: body.title.trim(),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.ownerRoleId === undefined ? {} : { ownerRoleId: body.ownerRoleId }),
        ...(body.doneCriterion === undefined ? {} : { doneCriterion: body.doneCriterion }),
        state,
        ...(body.blockedReason === undefined ? {} : { blockedReason: body.blockedReason }),
        createdBy: `human:${request.tenantId}`,
      });
      await reply.code(201).send(serializeTask(task));
    } catch (error) {
      request.log.warn({ err: error }, "Project task create failed");
      badRequest(reply, (error as Error).message);
    }
  });

  app.patch<{
    Params: { id: string; taskId: string };
    Body: { state?: ProjectTaskState; blockedReason?: string; ownerRoleId?: string };
  }>("/projects/:id/tasks/:taskId", { schema: { body: PATCH_TASK_SCHEMA } }, async (request, reply) => {
    const port = ports(reply);
    if (port === undefined) return;
    try {
      const project = await ownedProject(request as FastifyRequest<{ Params: { id: string } }>, reply, port);
      if (project === undefined) return;
      const notFoundTask = () => void reply.code(404).send({ error: "task not found" });
      if (!UUID_RE.test(request.params.taskId)) {
        notFoundTask();
        return;
      }
      const task = await port.getTask(request.params.taskId);
      if (task === null || task.projectId !== project.projectId) {
        notFoundTask();
        return;
      }
      const body = request.body;
      if (body.state === undefined && body.blockedReason !== undefined) {
        badRequest(reply, "blockedReason requires a state change to blocked.");
        return;
      }
      if (body.state !== undefined) {
        if (!TASK_TRANSITIONS[task.state].includes(body.state)) {
          badRequest(reply, `a work item cannot move from ${task.state} to ${body.state}.`);
          return;
        }
        if (body.state === "blocked" && (body.blockedReason ?? "").trim().length === 0) {
          badRequest(reply, "a blocked work item requires a blockedReason.");
          return;
        }
        if (body.state !== "blocked" && body.blockedReason !== undefined) {
          badRequest(reply, "blockedReason is only valid when moving to blocked.");
          return;
        }
      }
      if (body.ownerRoleId !== undefined) {
        const roster = await port.listRoster(project.projectId);
        if (!roster.some((member) => member.roleId === body.ownerRoleId)) {
          badRequest(reply, "a work item's owner must be on the project roster.");
          return;
        }
      }
      let updated: ProjectTask | null = task;
      if (body.state !== undefined) {
        updated = await port.updateTaskState(task.taskId, body.state, body.blockedReason);
        if (updated !== null) {
          await audit(deps, request.tenantId, "project.task_transition", {
            task_id: task.taskId,
            from: task.state,
            to: body.state,
            actor: `human:${request.tenantId}`,
          });
        }
      }
      if (updated !== null && body.ownerRoleId !== undefined) {
        updated = await port.assignTaskOwner(task.taskId, body.ownerRoleId);
      }
      if (updated === null) {
        notFoundTask();
        return;
      }
      await reply.code(200).send(serializeTask(updated));
    } catch (error) {
      request.log.warn({ err: error }, "Project task update failed");
      badRequest(reply, (error as Error).message);
    }
  });

  app.get<{ Params: { id: string } }>("/projects/:id/artifacts", async (request, reply) => {
    const port = ports(reply);
    if (port === undefined) return;
    try {
      const project = await ownedProject(request, reply, port);
      if (project === undefined) return;
      const artifacts = await port.listArtifacts({ projectId: project.projectId });
      await reply.code(200).send(artifacts.map((artifact) => ({ ...artifact, createdAt: artifact.createdAt.toISOString() })));
    } catch (error) {
      badRequest(reply, (error as Error).message);
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      kind: ProjectArtifactKind;
      ref: string;
      label: string;
      taskId?: string;
      sha256?: string;
      byteSize?: number;
      producedByRoleId?: string;
      producedByRunId?: string;
    };
  }>("/projects/:id/artifacts", { schema: { body: CREATE_ARTIFACT_SCHEMA } }, async (request, reply) => {
    const port = ports(reply);
    if (port === undefined) return;
    try {
      const project = await ownedProject(request, reply, port);
      if (project === undefined) return;
      const body = request.body;
      if (!isValidArtifactRef(project.projectId, body.kind, body.ref)) {
        badRequest(reply, "a workspace_file ref must be a canonical path under this project's workspace directory.");
        return;
      }
      if (body.taskId !== undefined) {
        const task = UUID_RE.test(body.taskId) ? await port.getTask(body.taskId) : null;
        if (task === null || task.projectId !== project.projectId) {
          badRequest(reply, "taskId must be a work item of this project.");
          return;
        }
      }
      const artifact = await port.createArtifact({
        projectId: project.projectId,
        kind: body.kind,
        ref: body.ref,
        label: body.label,
        ...(body.taskId === undefined ? {} : { taskId: body.taskId }),
        ...(body.sha256 === undefined ? {} : { sha256: body.sha256 }),
        ...(body.byteSize === undefined ? {} : { byteSize: body.byteSize }),
        ...(body.producedByRoleId === undefined ? {} : { producedByRoleId: body.producedByRoleId }),
        ...(body.producedByRunId === undefined ? {} : { producedByRunId: body.producedByRunId }),
      });
      await reply.code(201).send({ ...artifact, createdAt: artifact.createdAt.toISOString() });
    } catch (error) {
      request.log.warn({ err: error }, "Project artifact register failed");
      badRequest(reply, (error as Error).message);
    }
  });

  app.get<{ Params: { id: string } }>("/projects/:id/decisions", async (request, reply) => {
    const port = ports(reply);
    if (port === undefined) return;
    try {
      const project = await ownedProject(request, reply, port);
      if (project === undefined) return;
      const decisions = await port.listDecisions({ projectId: project.projectId });
      await reply.code(200).send(decisions.map((decision) => ({ ...decision, createdAt: decision.createdAt.toISOString() })));
    } catch (error) {
      badRequest(reply, (error as Error).message);
    }
  });
}
