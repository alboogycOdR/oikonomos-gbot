import { describe, expect, it, vi } from "vitest";
import { createProjectTools } from "./projectTools.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const manager = "33333333-3333-3333-3333-333333333333";
const member = "44444444-4444-4444-4444-444444444444";
const task = { taskId, projectId, title: "Ship it", description: "", ownerRoleId: null, state: "todo" as const, blockedReason: null, doneCriterion: "", createdBy: `role:${manager}`, createdAt: new Date(), updatedAt: new Date() };

function tools(extra: Record<string, unknown> = {}) {
  return createProjectTools({ connectionString: "postgres://unused", tenantId: "tenant", fromRoleId: manager, runId: "run" }, {
    listTasks: vi.fn(async () => [task]), getTask: vi.fn(async () => task), createTask: vi.fn(async (input) => ({ ...task, ...input })), updateTask: vi.fn(async (_id, state, blockedReason) => ({ ...task, state, blockedReason: blockedReason ?? null })), assignOwner: vi.fn(async (_id, ownerRoleId) => ({ ...task, ownerRoleId })), members: vi.fn(async () => [{ projectId, roleId: manager, isManager: true, responsibility: "manager" }, { projectId, roleId: member, isManager: false, responsibility: "builder" }]), createArtifact: vi.fn(async (input) => input), createDecision: vi.fn(async (input) => input), sendAssignment: vi.fn(async () => undefined), audit: vi.fn(async () => undefined), resolvePath: (ref) => ref,
    ...extra,
  });
}

describe("project tools", () => {
  it("enforces the task state machine and audits a legal transition", async () => {
    const audit = vi.fn(async () => undefined); const updateTask = vi.fn(async (_id, state) => ({ ...task, state }));
    await expect(tools({ audit, updateTask }).update_task({ taskId, state: "done" })).rejects.toThrow("Illegal");
    await expect(tools({ audit, updateTask }).update_task({ taskId, state: "doing" })).resolves.toMatchObject({ state: "doing" });
    expect(audit).toHaveBeenCalledWith("project.task_transition", { task_id: taskId, from: "todo", to: "doing", actor: `role:${manager}` });
    const doing = { ...task, state: "doing" as const };
    await expect(tools({ getTask: vi.fn(async () => doing) }).update_task({ taskId, state: "blocked" })).rejects.toThrow("Illegal");
    await expect(tools({ getTask: vi.fn(async () => doing) }).update_task({ taskId, state: "blocked", blockedReason: "Waiting for approval" })).resolves.toMatchObject({ state: "blocked" });
    for (const state of ["todo", "doing", "blocked", "review"] as const) {
      await expect(tools({ getTask: vi.fn(async () => ({ ...task, state })) }).update_task({ taskId, state: "cancelled" })).resolves.toMatchObject({ state: "cancelled" });
    }
  });

  it("denies non-managers, non-roster owners, and caps assignment handoffs at roster size", async () => {
    const denied = createProjectTools({ connectionString: "x", tenantId: "t", fromRoleId: member }, { getTask: async () => task, members: async () => [{ projectId, roleId: member, isManager: false, responsibility: "" }] });
    await expect(denied.create_task({ projectId, title: "no" })).rejects.toThrow("manager");
    await expect(denied.update_task({ taskId, state: "doing" })).rejects.toThrow("manager");
    await expect(denied.assign_task({ taskId, ownerRoleId: member })).rejects.toThrow("manager");
    await expect(denied.register_artifact({ projectId, kind: "attachment", ref: "attachment-1", label: "no" })).rejects.toThrow("manager");
    await expect(denied.record_decision({ projectId, kind: "human_decision", summary: "no" })).rejects.toThrow("manager");
    await expect(tools().assign_task({ taskId, ownerRoleId: "55555555-5555-5555-5555-555555555555" })).rejects.toThrow("roster");
    const audit = vi.fn(async () => undefined); const assign = tools({ audit });
    await assign.assign_task({ taskId, ownerRoleId: member }); await assign.assign_task({ taskId, ownerRoleId: member });
    await expect(assign.assign_task({ taskId, ownerRoleId: member })).rejects.toThrow("fan-out");
    expect(audit).toHaveBeenCalledWith("project.fanout_capped", expect.objectContaining({ roster_size: 2 }));
  });

  it("audits an assignment after its durable mutation and before handoff delivery", async () => {
    const audit = vi.fn(async () => undefined);
    const sendAssignment = vi.fn(async () => { throw new Error("mailbox unavailable"); });
    await expect(tools({ audit, sendAssignment }).assign_task({ taskId, ownerRoleId: member })).rejects.toThrow("mailbox unavailable");
    expect(audit).toHaveBeenCalledWith("project.task_assigned", {
      project_id: projectId, task_id: taskId, owner_role_id: member, actor: `role:${manager}`,
    });
  });

  it("stores only valid canonical project workspace-file references", async () => {
    const createArtifact = vi.fn(async (input) => input);
    await expect(tools({ createArtifact, resolvePath: () => "/oikonomos/workspace/projects/other/a" }).register_artifact({ projectId, kind: "workspace_file", ref: `/oikonomos/workspace/projects/${projectId}/../escape`, label: "x" })).rejects.toThrow("canonical");
    await expect(tools({ createArtifact }).register_artifact({ projectId, kind: "workspace_file", ref: `/oikonomos/workspace/projects/${projectId}/report.md`, label: "x" })).resolves.toBeDefined();
    expect(createArtifact).toHaveBeenCalledWith(expect.not.objectContaining({ bytes: expect.anything() }));
  });
});
