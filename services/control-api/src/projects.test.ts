import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { Project, ProjectArtifact, ProjectRoleMember, ProjectTask } from "@oikonomos/db";

import { buildApp } from "./app.js";
import { MANAGER_CHARTER_DUTIES } from "./charters/managerCharter.js";
import type { ControlApiDeps, ProjectPorts } from "./ports.js";

const AUTH = { authorization: "Bearer secret" };
const OWN = "basileia";

const roleIds = ["r1", "r2", "r3"];

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    projectId: randomUUID(),
    tenantId: OWN,
    threadId: randomUUID(),
    name: "P",
    goal: "g",
    doneCriterion: "d",
    status: "active",
    budgetUsd: null,
    createdBy: "human:basileia",
    createdAt: new Date("2026-09-19T10:00:00.000Z"),
    updatedAt: new Date("2026-09-19T10:00:00.000Z"),
    ...overrides,
  };
}

function makeTask(project: Project, overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    taskId: randomUUID(),
    projectId: project.projectId,
    title: "t",
    description: "",
    ownerRoleId: null,
    state: "todo",
    blockedReason: null,
    doneCriterion: "",
    createdBy: "human:basileia",
    createdAt: new Date("2026-09-19T10:00:00.000Z"),
    updatedAt: new Date("2026-09-19T10:00:00.000Z"),
    ...overrides,
  };
}

const capabilities = [
  { capabilityId: "project.read", description: "", defaultTier: "T0_observe", adapter: "mcp:project", enabled: true },
  { capabilityId: "project.task_write", description: "", defaultTier: "T2_internal", adapter: "mcp:project", enabled: true },
  { capabilityId: "project.assign", description: "", defaultTier: "T2_internal", adapter: "mcp:project", enabled: true },
  { capabilityId: "project.artifact_write", description: "", defaultTier: "T2_internal", adapter: "mcp:project", enabled: true },
  { capabilityId: "project.decision_write", description: "", defaultTier: "T2_internal", adapter: "mcp:project", enabled: true },
  { capabilityId: "project.request_grant", description: "", defaultTier: "T3_external", adapter: "mcp:project", enabled: false },
  { capabilityId: "project.create_role", description: "", defaultTier: "T3_external", adapter: "mcp:project", enabled: true },
  { capabilityId: "workspace.create_bot", description: "", defaultTier: "T3_external", adapter: "sdk:builtin", enabled: true },
  { capabilityId: "workspace.retire_bot", description: "", defaultTier: "T4_irreversible", adapter: "sdk:builtin", enabled: true },
  { capabilityId: "gmail.send", description: "", defaultTier: "T3_external", adapter: "x", enabled: true },
];

interface Fixture {
  app: ReturnType<typeof buildApp>;
  port: { [K in keyof ProjectPorts]: ReturnType<typeof vi.fn> };
  audit: ReturnType<typeof vi.fn>;
  updateRoleInstructions: ReturnType<typeof vi.fn>;
  createRoutine: ReturnType<typeof vi.fn>;
  projects: Map<string, Project>;
  tasks: Map<string, ProjectTask>;
  artifacts: ProjectArtifact[];
  ownedThreadIds: Set<string>;
  roster: ProjectRoleMember[];
}

function fixture(): Fixture {
  const projects = new Map<string, Project>();
  const tasks = new Map<string, ProjectTask>();
  const artifacts: ProjectArtifact[] = [];
  const ownedThreadIds = new Set<string>();
  const roster: ProjectRoleMember[] = roleIds.map((roleId, i) => ({
    projectId: "x",
    roleId,
    isManager: i === 0,
    responsibility: "",
  }));
  const audit = vi.fn(async () => undefined);
  const port = {
    createProject: vi.fn(async (input: { name: string; tenantId: string; roster: Array<{ roleId: string; isManager?: boolean }> }) => {
      const project = makeProject({ name: input.name, tenantId: input.tenantId });
      projects.set(project.projectId, project);
      ownedThreadIds.add(project.threadId);
      return {
        project,
        roster: input.roster.map((member) => ({
          projectId: project.projectId,
          roleId: member.roleId,
          isManager: member.isManager === true,
          responsibility: "",
        })),
      };
    }),
    getProject: vi.fn(async (id: string) => projects.get(id) ?? null),
    listProjects: vi.fn(async (filter: { tenantId: string }) => [...projects.values()].filter((p) => p.tenantId === filter.tenantId)),
    updateProject: vi.fn(async (input: { projectId: string; status?: Project["status"]; managerRoleId?: string | null }) => {
      const current = projects.get(input.projectId);
      if (current === undefined) return null;
      const next = { ...current, ...(input.status === undefined ? {} : { status: input.status }) };
      projects.set(next.projectId, next);
      return {
        project: next,
        roster: roster.map((member) => ({
          ...member,
          projectId: next.projectId,
          isManager: input.managerRoleId === undefined ? member.isManager : member.roleId === input.managerRoleId,
        })),
      };
    }),
    getOverview: vi.fn(async () => ({
      charter: { "charter.goal": "g" },
      roster,
      taskCounts: { todo: 1, doing: 0, blocked: 2, review: 0, done: 0, cancelled: 0 },
      spendUsd: 1.5,
    })),
    listRoster: vi.fn(async () => roster),
    listTasks: vi.fn(async (filter: { projectId: string }) => [...tasks.values()].filter((t) => t.projectId === filter.projectId)),
    createTask: vi.fn(async (input: { projectId: string; title: string; ownerRoleId?: string; state?: ProjectTask["state"]; blockedReason?: string }) => {
      const task = makeTask(projects.get(input.projectId)!, {
        title: input.title,
        ownerRoleId: input.ownerRoleId ?? null,
        state: input.state ?? "todo",
        blockedReason: input.blockedReason ?? null,
      });
      tasks.set(task.taskId, task);
      return task;
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
    updateTaskState: vi.fn(async (id: string, state: ProjectTask["state"], reason?: string) => {
      const next = { ...tasks.get(id)!, state, blockedReason: state === "blocked" ? (reason ?? null) : null };
      tasks.set(id, next);
      return next;
    }),
    assignTaskOwner: vi.fn(async (id: string, ownerRoleId: string) => {
      const next = { ...tasks.get(id)!, ownerRoleId };
      tasks.set(id, next);
      return next;
    }),
    listArtifacts: vi.fn(async () => artifacts),
    createArtifact: vi.fn(async (input: { projectId: string; kind: ProjectArtifact["kind"]; ref: string; label: string; taskId?: string }) => {
      const artifact: ProjectArtifact = {
        artifactId: randomUUID(),
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        kind: input.kind,
        ref: input.ref,
        sha256: null,
        byteSize: null,
        producedByRoleId: null,
        producedByRunId: null,
        label: input.label,
        createdAt: new Date("2026-09-19T11:00:00.000Z"),
      };
      artifacts.unshift(artifact);
      return artifact;
    }),
    listDecisions: vi.fn(async (filter: { projectId: string }) => [
      {
        decisionId: randomUUID(),
        projectId: filter.projectId,
        taskId: null,
        kind: "approval" as const,
        approvalId: "11111111-1111-4111-8111-111111111111",
        summary: "approval granted for gmail.send",
        actor: "human:1",
        createdAt: new Date("2026-09-19T12:00:00.000Z"),
      },
    ]),
  };
  const updateRoleInstructions = vi.fn(async () => null);
  const createRoutine = vi.fn(async (input: Record<string, unknown>) => input);
  const deps = {
    updateRoleInstructions,
    createRoutine,
    listRoutines: vi.fn(async () => []),
    projects: port,
    insertAuditEvent: audit,
    listCapabilities: vi.fn(async () => capabilities),
    listRoles: vi.fn(async () => roleIds.map((roleId) => ({ roleId }))),
    listAllThreadsWithMembers: vi.fn(async () => [...ownedThreadIds].map((id) => ({ id, roleId: null, memberRoleIds: roleIds }))),
  } as unknown as ControlApiDeps;
  const app = buildApp(deps, { authToken: "secret", logger: false });
  return { app, updateRoleInstructions, createRoutine, port: port as unknown as Fixture["port"], audit, projects, tasks, artifacts, ownedThreadIds, roster };
}

async function seedProject(f: Fixture, overrides: Partial<Project> = {}): Promise<Project> {
  const project = makeProject(overrides);
  f.projects.set(project.projectId, project);
  f.ownedThreadIds.add(project.threadId);
  return project;
}

const newProjectBody = {
  name: "Launch",
  goal: "ship",
  doneCriterion: "shipped",
  boundaries: "no prod",
  checkWithMeBefore: "spend",
  roster: [{ roleId: "r1", isManager: true, responsibility: "lead" }, { roleId: "r2" }],
};

describe("project routes (TASK-304)", () => {
  it("answers 501 when no project port is configured", async () => {
    const app = buildApp({} as unknown as ControlApiDeps, { authToken: "secret", logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/projects", headers: AUTH });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("requires authentication like every other route", async () => {
    const f = fixture();
    try {
      expect((await f.app.inject({ method: "GET", url: "/projects" })).statusCode).toBe(401);
    } finally {
      await f.app.close();
    }
  });

  describe("POST /projects", () => {
    it("creates through one port call with exactly the enabled project.* grants plus create_bot", async () => {
      const f = fixture();
      try {
        const response = await f.app.inject({ method: "POST", url: "/projects", headers: AUTH, payload: newProjectBody });
        expect(response.statusCode).toBe(201);
        expect(f.port.createProject).toHaveBeenCalledTimes(1);
        const call = f.port.createProject.mock.calls[0]![0] as {
          tenantId: string;
          charter: Record<string, string>;
          managerGrants: Array<{ capabilityId: string; maxTier: string }>;
        };
        expect(call.tenantId).toBe(OWN);
        expect(call.charter).toEqual({ boundaries: "no prod", checkWithMeBefore: "spend" });
        expect(call.managerGrants.map((g) => g.capabilityId).sort()).toEqual([
          "project.artifact_write",
          "project.assign",
          "project.decision_write",
          "project.read",
          "project.task_write",
          "workspace.create_bot",
        ]);
        const ids = call.managerGrants.map((g) => g.capabilityId);
        for (const banned of ["project.request_grant", "project.create_role", "workspace.retire_bot", "gmail.send"]) {
          expect(ids).not.toContain(banned);
        }
        expect(call.managerGrants.find((g) => g.capabilityId === "workspace.create_bot")?.maxTier).toBe("T3_external");
        expect(response.json()).toMatchObject({ project: { name: "Launch" }, roster: [{ roleId: "r1", isManager: true }, { roleId: "r2" }] });
        expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "project.created" }));
      } finally {
        await f.app.close();
      }
    });

    it("seeds the manager's instructions from the charter and creates a changes_only status routine (TASK-305)", async () => {
      const f = fixture();
      try {
        const response = await f.app.inject({ method: "POST", url: "/projects", headers: AUTH, payload: newProjectBody });
        expect(response.statusCode).toBe(201);
        expect(f.updateRoleInstructions).toHaveBeenCalledTimes(1);
        const [roleId, text] = f.updateRoleInstructions.mock.calls[0] as unknown as [string, string];
        expect(roleId).toBe("r1");
        for (const duty of MANAGER_CHARTER_DUTIES) expect(text).toContain(duty);
        expect(f.createRoutine).toHaveBeenCalledTimes(1);
        const routine = f.createRoutine.mock.calls[0]![0] as { roleId: string; notifyThreshold: string };
        expect(routine.roleId).toBe("r1");
        expect(routine.notifyThreshold).toBe("changes_only");
      } finally {
        await f.app.close();
      }
    });

    it("seeds nothing when no manager is chosen (TASK-305)", async () => {
      const f = fixture();
      try {
        await f.app.inject({
          method: "POST",
          url: "/projects",
          headers: AUTH,
          payload: { ...newProjectBody, roster: [{ roleId: "r1" }, { roleId: "r2" }] },
        });
        expect(f.updateRoleInstructions).not.toHaveBeenCalled();
        expect(f.createRoutine).not.toHaveBeenCalled();
      } finally {
        await f.app.close();
      }
    });

    it("grants nothing when no manager is chosen", async () => {
      const f = fixture();
      try {
        const response = await f.app.inject({
          method: "POST",
          url: "/projects",
          headers: AUTH,
          payload: { ...newProjectBody, roster: [{ roleId: "r1" }, { roleId: "r2" }] },
        });
        expect(response.statusCode).toBe(201);
        expect((f.port.createProject.mock.calls[0]![0] as { managerGrants: unknown[] }).managerGrants).toEqual([]);
      } finally {
        await f.app.close();
      }
    });

    it("rejects a roster of one, more than six, and two managers before any write", async () => {
      const f = fixture();
      try {
        const post = (roster: unknown) =>
          f.app.inject({ method: "POST", url: "/projects", headers: AUTH, payload: { ...newProjectBody, roster } });
        expect((await post([{ roleId: "r1" }])).statusCode).toBe(400);
        expect((await post(Array.from({ length: 7 }, (_, i) => ({ roleId: `r${i}` })))).statusCode).toBe(400);
        expect((await post([{ roleId: "r1", isManager: true }, { roleId: "r2", isManager: true }])).statusCode).toBe(400);
        expect(f.port.createProject).not.toHaveBeenCalled();
      } finally {
        await f.app.close();
      }
    });

    it("turns a storage failure into a 400 without leaking a project", async () => {
      const f = fixture();
      try {
        f.port.createProject.mockRejectedValueOnce(new Error("every roster role must be an active role of this tenant."));
        const response = await f.app.inject({ method: "POST", url: "/projects", headers: AUTH, payload: newProjectBody });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "every roster role must be an active role of this tenant." });
        expect(f.projects.size).toBe(0);
      } finally {
        await f.app.close();
      }
    });
  });

  describe("tenant scoping: 404, never 403", () => {
    it("hides another tenant's project and a project whose thread is not the caller's on every route", async () => {
      const f = fixture();
      try {
        const foreign = await seedProject(f, { tenantId: "someone-else" });
        const unownedThread = await seedProject(f);
        f.ownedThreadIds.delete(unownedThread.threadId);
        const task = makeTask(foreign);
        f.tasks.set(task.taskId, task);
        const routes: Array<[string, string, unknown?]> = [];
        for (const p of [foreign, unownedThread]) {
          routes.push(
            ["GET", `/projects/${p.projectId}`],
            ["PATCH", `/projects/${p.projectId}`, { status: "paused" }],
            ["GET", `/projects/${p.projectId}/tasks`],
            ["POST", `/projects/${p.projectId}/tasks`, { title: "x" }],
            ["PATCH", `/projects/${p.projectId}/tasks/${task.taskId}`, { state: "doing" }],
            ["GET", `/projects/${p.projectId}/artifacts`],
            ["POST", `/projects/${p.projectId}/artifacts`, { kind: "run_receipt", ref: "r", label: "l" }],
            ["GET", `/projects/${p.projectId}/decisions`],
          );
        }
        routes.push(["GET", "/projects/not-a-uuid"], ["GET", `/projects/${randomUUID()}`]);
        for (const [method, url, payload] of routes) {
          const response = await f.app.inject({ method: method as "GET", url, headers: AUTH, payload: payload as object | undefined });
          expect(response.statusCode, `${method} ${url}`).toBe(404);
        }
        expect(f.port.updateProject).not.toHaveBeenCalled();
        expect(f.port.createTask).not.toHaveBeenCalled();
        expect(f.port.createArtifact).not.toHaveBeenCalled();
      } finally {
        await f.app.close();
      }
    });

    it("lists only the caller's projects", async () => {
      const f = fixture();
      try {
        const mine = await seedProject(f);
        await seedProject(f, { tenantId: "someone-else" });
        const unowned = await seedProject(f);
        f.ownedThreadIds.delete(unowned.threadId);
        const response = await f.app.inject({ method: "GET", url: "/projects?status=active", headers: AUTH });
        expect(response.statusCode).toBe(200);
        expect((response.json() as Array<{ projectId: string }>).map((p) => p.projectId)).toEqual([mine.projectId]);
      } finally {
        await f.app.close();
      }
    });
  });

  describe("GET /projects/:id", () => {
    it("returns charter, roster, board summary, latest STATUS.md artifact and spend vs budget", async () => {
      const f = fixture();
      try {
        const project = await seedProject(f, { budgetUsd: 10 });
        f.artifacts.push(
          {
            artifactId: randomUUID(),
            projectId: project.projectId,
            taskId: null,
            kind: "workspace_file",
            ref: `/oikonomos/workspace/projects/${project.projectId}/STATUS.md`,
            sha256: null,
            byteSize: null,
            producedByRoleId: "r1",
            producedByRunId: null,
            label: "status",
            createdAt: new Date("2026-09-19T09:00:00.000Z"),
          },
        );
        const response = await f.app.inject({ method: "GET", url: `/projects/${project.projectId}`, headers: AUTH });
        expect(response.statusCode).toBe(200);
        const body = response.json() as Record<string, any>;
        expect(body.charter).toEqual({ "charter.goal": "g" });
        expect(body.roster).toHaveLength(3);
        expect(body.board).toMatchObject({ blocked: 2 });
        expect(body.latestStatusArtifact.ref).toMatch(/STATUS\.md$/);
        expect(body.spend).toEqual({ usd: 1.5, budgetUsd: 10 });
      } finally {
        await f.app.close();
      }
    });
  });

  describe("PATCH /projects/:id", () => {
    it("promotes a manager with the resolved grant set and demotes with none", async () => {
      const f = fixture();
      try {
        const project = await seedProject(f);
        const promote = await f.app.inject({
          method: "PATCH",
          url: `/projects/${project.projectId}`,
          headers: AUTH,
          payload: { managerRoleId: "r2" },
        });
        expect(promote.statusCode).toBe(200);
        const promoteCall = f.port.updateProject.mock.calls[0]![0] as { managerRoleId: string; managerGrants: Array<{ capabilityId: string }> };
        expect(promoteCall.managerRoleId).toBe("r2");
        expect(promoteCall.managerGrants.map((g) => g.capabilityId)).toContain("workspace.create_bot");
        expect(promoteCall.managerGrants.map((g) => g.capabilityId)).not.toContain("workspace.retire_bot");

        const demote = await f.app.inject({
          method: "PATCH",
          url: `/projects/${project.projectId}`,
          headers: AUTH,
          payload: { managerRoleId: null },
        });
        expect(demote.statusCode).toBe(200);
        const demoteCall = f.port.updateProject.mock.calls[1]![0] as { managerRoleId: string | null; managerGrants: unknown[] };
        expect(demoteCall.managerRoleId).toBeNull();
        expect(demoteCall.managerGrants).toEqual([]);
      } finally {
        await f.app.close();
      }
    });

    it("does not let a patch smuggle in a manager via addMembers, and rejects an empty or unknown body", async () => {
      const f = fixture();
      try {
        const project = await seedProject(f);
        const url = `/projects/${project.projectId}`;
        await f.app.inject({ method: "PATCH", url, headers: AUTH, payload: { addMembers: [{ roleId: "r3", isManager: true }] } });
        const call = f.port.updateProject.mock.calls[0]![0] as { addMembers: Array<{ isManager: boolean }> };
        expect(call.addMembers.every((member) => member.isManager === false)).toBe(true);
        expect((await f.app.inject({ method: "PATCH", url, headers: AUTH, payload: {} })).statusCode).toBe(400);
        expect((await f.app.inject({ method: "PATCH", url, headers: AUTH, payload: { status: "bogus" } })).statusCode).toBe(400);
      } finally {
        await f.app.close();
      }
    });
  });

  describe("work items", () => {
    it("refuses a blocked item without a reason and an owner who is not on the roster", async () => {
      const f = fixture();
      try {
        const project = await seedProject(f);
        const url = `/projects/${project.projectId}/tasks`;
        expect((await f.app.inject({ method: "POST", url, headers: AUTH, payload: { title: "t", state: "blocked" } })).statusCode).toBe(400);
        expect((await f.app.inject({ method: "POST", url, headers: AUTH, payload: { title: "t", state: "blocked", blockedReason: "  " } })).statusCode).toBe(400);
        expect((await f.app.inject({ method: "POST", url, headers: AUTH, payload: { title: "t", blockedReason: "why" } })).statusCode).toBe(400);
        expect((await f.app.inject({ method: "POST", url, headers: AUTH, payload: { title: "t", ownerRoleId: "stranger" } })).statusCode).toBe(400);
        expect(f.port.createTask).not.toHaveBeenCalled();

        const ok = await f.app.inject({ method: "POST", url, headers: AUTH, payload: { title: "t", ownerRoleId: "r2" } });
        expect(ok.statusCode).toBe(201);
        const blocked = await f.app.inject({ method: "POST", url, headers: AUTH, payload: { title: "b", state: "blocked", blockedReason: "waiting" } });
        expect(blocked.statusCode).toBe(201);
        expect(blocked.json()).toMatchObject({ state: "blocked", blockedReason: "waiting" });
        const listed = await f.app.inject({ method: "GET", url: `${url}?state=blocked`, headers: AUTH });
        expect(listed.statusCode).toBe(200);
      } finally {
        await f.app.close();
      }
    });

    it("enforces the state machine, requires a reason to block, and audits every transition", async () => {
      const f = fixture();
      try {
        const project = await seedProject(f);
        const task = makeTask(project, { state: "todo" });
        f.tasks.set(task.taskId, task);
        const url = `/projects/${project.projectId}/tasks/${task.taskId}`;
        const patch = (payload: unknown) => f.app.inject({ method: "PATCH", url, headers: AUTH, payload: payload as object });

        expect((await patch({ state: "done" })).statusCode).toBe(400); // todo -> done
        expect((await patch({ state: "blocked", blockedReason: "x" })).statusCode).toBe(400); // blocked only from doing
        expect((await patch({ blockedReason: "x" })).statusCode).toBe(400);
        expect(f.audit).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: "project.task_transition" }));

        expect((await patch({ state: "doing" })).statusCode).toBe(200);
        expect((await patch({ state: "blocked" })).statusCode).toBe(400); // no reason
        const blocked = await patch({ state: "blocked", blockedReason: "waiting on key" });
        expect(blocked.statusCode).toBe(200);
        expect(blocked.json()).toMatchObject({ state: "blocked", blockedReason: "waiting on key" });
        expect(f.audit).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: "project.task_transition",
            payload: expect.objectContaining({ task_id: task.taskId, from: "doing", to: "blocked" }),
          }),
        );
        expect(f.audit.mock.calls.filter((c) => (c[0] as { eventType: string }).eventType === "project.task_transition")).toHaveLength(2);
        // terminal states do not move
        f.tasks.set(task.taskId, { ...f.tasks.get(task.taskId)!, state: "done", blockedReason: null });
        expect((await patch({ state: "doing" })).statusCode).toBe(400);
      } finally {
        await f.app.close();
      }
    });

    it("reassigns only to a roster member and 404s a task from another project", async () => {
      const f = fixture();
      try {
        const project = await seedProject(f);
        const other = await seedProject(f);
        const task = makeTask(project);
        const otherTask = makeTask(other);
        f.tasks.set(task.taskId, task);
        f.tasks.set(otherTask.taskId, otherTask);
        const url = `/projects/${project.projectId}/tasks/${task.taskId}`;
        expect((await f.app.inject({ method: "PATCH", url, headers: AUTH, payload: { ownerRoleId: "stranger" } })).statusCode).toBe(400);
        const ok = await f.app.inject({ method: "PATCH", url, headers: AUTH, payload: { ownerRoleId: "r3" } });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toMatchObject({ ownerRoleId: "r3" });
        const crossed = await f.app.inject({
          method: "PATCH",
          url: `/projects/${project.projectId}/tasks/${otherTask.taskId}`,
          headers: AUTH,
          payload: { state: "doing" },
        });
        expect(crossed.statusCode).toBe(404);
        expect((await f.app.inject({ method: "PATCH", url: `/projects/${project.projectId}/tasks/nope`, headers: AUTH, payload: { state: "doing" } })).statusCode).toBe(404);
      } finally {
        await f.app.close();
      }
    });
  });

  describe("artifacts and decisions", () => {
    it("rejects a workspace_file outside the project directory and accepts one inside", async () => {
      const f = fixture();
      try {
        const project = await seedProject(f);
        const url = `/projects/${project.projectId}/artifacts`;
        const post = (payload: object) => f.app.inject({ method: "POST", url, headers: AUTH, payload });
        for (const ref of [
          "/etc/passwd",
          `/oikonomos/workspace/projects/${randomUUID()}/x.md`,
          `/oikonomos/workspace/projects/${project.projectId}/../other/x.md`,
          `/oikonomos/workspace/projects/${project.projectId}`,
        ]) {
          expect((await post({ kind: "workspace_file", ref, label: "x" })).statusCode, ref).toBe(400);
        }
        expect(f.port.createArtifact).not.toHaveBeenCalled();
        const inside = await post({
          kind: "workspace_file",
          ref: `/oikonomos/workspace/projects/${project.projectId}/notes/a.md`,
          label: "a",
        });
        expect(inside.statusCode).toBe(201);
        expect((await post({ kind: "run_receipt", ref: randomUUID(), label: "r" })).statusCode).toBe(201);
        const foreignTask = makeTask(await seedProject(f));
        f.tasks.set(foreignTask.taskId, foreignTask);
        expect((await post({ kind: "run_receipt", ref: "r", label: "r", taskId: foreignTask.taskId })).statusCode).toBe(400);
        const listed = await f.app.inject({ method: "GET", url, headers: AUTH });
        expect(listed.json()).toHaveLength(2);
      } finally {
        await f.app.close();
      }
    });

    it("lists decisions with the approval referenced by id, never its render", async () => {
      const f = fixture();
      try {
        const project = await seedProject(f);
        const response = await f.app.inject({ method: "GET", url: `/projects/${project.projectId}/decisions`, headers: AUTH });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([
          expect.objectContaining({ kind: "approval", approvalId: "11111111-1111-4111-8111-111111111111" }),
        ]);
        expect(JSON.stringify(response.json())).not.toMatch(/action_render|actionRender/);
      } finally {
        await f.app.close();
      }
    });
  });

  it("documents every project route in openapi.json", async () => {
    const f = fixture();
    try {
      const doc = (await f.app.inject({ method: "GET", url: "/openapi.json", headers: AUTH })).json() as { paths: Record<string, Record<string, unknown>> };
      expect(Object.keys(doc.paths["/projects"]!).sort()).toEqual(["get", "post"]);
      expect(Object.keys(doc.paths["/projects/{id}"]!).sort()).toEqual(["get", "patch"]);
      expect(Object.keys(doc.paths["/projects/{id}/tasks"]!).sort()).toEqual(["get", "post"]);
      expect(Object.keys(doc.paths["/projects/{id}/tasks/{taskId}"]!)).toEqual(["patch"]);
      expect(Object.keys(doc.paths["/projects/{id}/artifacts"]!).sort()).toEqual(["get", "post"]);
      expect(Object.keys(doc.paths["/projects/{id}/decisions"]!)).toEqual(["get"]);
    } finally {
      await f.app.close();
    }
  });
});
