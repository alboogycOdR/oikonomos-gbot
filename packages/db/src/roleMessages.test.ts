import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";


import {
  createGroupThread,
  createProject,
  createProjectArtifact,
  createProjectTask,
  createRole,
  claimRoleMessageDelivery,
  failRoleMessageDelivery,
  defaultPoolConfig,
  getRoleMessage,
  listRoleMessages,
  markRoleMessageRead,
  sendRoleMessage,
} from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db roleMessages — read + CRUD + FK (TASK-084)", () => {
  let pool: Pool;
  const tenantId = "task-084-messages-suite";
  const fromRoleId = "task-084-messages-suite-from";
  const toRoleId = "task-084-messages-suite-to";
  const outsiderRoleId = "task-084-messages-suite-outsider";
  let projectId: string;
  let otherProjectId: string;
  let taskId: string;
  let otherTaskId: string;
  let artifactId: string;
  let otherArtifactId: string;

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM role_messages WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM project_artifacts WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)`, [tenantId]);
    await pool.query(`DELETE FROM project_tasks WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)`, [tenantId]);
    await pool.query(`DELETE FROM projects WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM thread_members WHERE thread_id IN (SELECT id FROM threads WHERE title LIKE $1)`, [`${tenantId}%`]);
    await pool.query(`DELETE FROM threads WHERE title LIKE $1`, [`${tenantId}%`]);
    await pool.query(`DELETE FROM roles WHERE role_id IN ($1, $2, $3)`, [fromRoleId, toRoleId, outsiderRoleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(
      { connectionString: connectionString! },
      { roleId: fromRoleId, tenantId, name: "From", title: "From Role" },
    );
    await createRole(
      { connectionString: connectionString! },
      { roleId: toRoleId, tenantId, name: "To", title: "To Role" },
    );
    await createRole(
      { connectionString: connectionString! },
      { roleId: outsiderRoleId, tenantId, name: "Outsider", title: "Outsider Role" },
    );
    const thread = await createGroupThread({ connectionString: connectionString! }, { roleIds: [fromRoleId, toRoleId], title: `${tenantId}-project` });
    const otherThread = await createGroupThread({ connectionString: connectionString! }, { roleIds: [fromRoleId, toRoleId], title: `${tenantId}-other-project` });
    const project = await createProject({ connectionString: connectionString! }, { tenantId, threadId: thread.id, name: "Project", goal: "Goal", doneCriterion: "Done", createdBy: "human:test" });
    const otherProject = await createProject({ connectionString: connectionString! }, { tenantId, threadId: otherThread.id, name: "Other", goal: "Goal", doneCriterion: "Done", createdBy: "human:test" });
    projectId = project.projectId;
    otherProjectId = otherProject.projectId;
    taskId = (await createProjectTask({ connectionString: connectionString! }, { projectId, title: "Work", createdBy: "human:test" })).taskId;
    otherTaskId = (await createProjectTask({ connectionString: connectionString! }, { projectId: otherProjectId, title: "Other work", createdBy: "human:test" })).taskId;
    artifactId = (await createProjectArtifact({ connectionString: connectionString! }, { projectId, taskId, kind: "attachment", ref: "attachment-good", label: "Good" })).artifactId;
    otherArtifactId = (await createProjectArtifact({ connectionString: connectionString! }, { projectId: otherProjectId, kind: "attachment", ref: "attachment-other", label: "Other" })).artifactId;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("sends a handoff and reads it back byte-identical; unread by default (F8)", async () => {
    const sent = await sendRoleMessage(
      { connectionString: connectionString! },
      {
        tenantId,
        fromRoleId,
        toRoleId,
        body: "see /workspace/report.md",
        workspaceRefs: ["/workspace/report.md"],
      },
    );

    expect(sent.readAt).toBeNull();
    expect(sent.workspaceRefs).toEqual(["/workspace/report.md"]);

    const fetched = await getRoleMessage({ connectionString: connectionString! }, sent.messageId);
    expect(fetched).toEqual(sent);
    expect(sent.handoffKind).toBeNull();
    expect(sent.factRef).toBeNull();
  });


  it("getRoleMessage returns null for an unknown messageId", async () => {
    const result = await getRoleMessage(
      { connectionString: connectionString! },
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });

  it("F8: from_role_id/to_role_id FKs reject a message referencing a role that does not exist", async () => {
    await expect(
      sendRoleMessage(
        { connectionString: connectionString! },
        { tenantId, fromRoleId: "task-084-messages-suite-nonexistent", toRoleId, body: "x" },
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      sendRoleMessage(
        { connectionString: connectionString! },
        { tenantId, fromRoleId, toRoleId: "task-084-messages-suite-nonexistent", body: "x" },
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("accepts every new project handoff kind and only accepts task.completed with a same-project registered artifact", async () => {
    for (const handoffKind of ["task.assigned", "task.blocked", "status.requested"] as const) {
      const sent = await sendRoleMessage({ connectionString: connectionString! }, {
        tenantId, fromRoleId, toRoleId, body: handoffKind, handoffKind,
        factRef: { project_id: projectId, task_id: taskId, artifact_ids: [] },
      });
      expect(sent.handoffKind).toBe(handoffKind);
    }
    await expect(sendRoleMessage({ connectionString: connectionString! }, {
      tenantId, fromRoleId, toRoleId, body: "wrong project", handoffKind: "task.completed",
      factRef: { project_id: projectId, task_id: taskId, artifact_ids: [otherArtifactId] },
    })).rejects.toThrow(/same project/);
    await expect(sendRoleMessage({ connectionString: connectionString! }, {
      tenantId, fromRoleId, toRoleId, body: "wrong task", handoffKind: "task.assigned",
      factRef: { project_id: projectId, task_id: otherTaskId, artifact_ids: [] },
    })).rejects.toThrow(/task_id.*same project/);
    await expect(sendRoleMessage({ connectionString: connectionString! }, {
      tenantId, fromRoleId, toRoleId, body: "wrong artifact on block", handoffKind: "task.blocked",
      factRef: { project_id: projectId, task_id: taskId, artifact_ids: [otherArtifactId] },
    })).rejects.toThrow(/artifact_ids.*same project/);
    await expect(sendRoleMessage({ connectionString: connectionString! }, {
      tenantId, fromRoleId, toRoleId, body: "missing artifact", handoffKind: "task.completed",
      factRef: { project_id: projectId, task_id: taskId, artifact_ids: ["00000000-0000-0000-0000-000000000000"] },
    })).rejects.toThrow(/same project/);
    const completed = await sendRoleMessage({ connectionString: connectionString! }, {
      tenantId, fromRoleId, toRoleId, body: "done", handoffKind: "task.completed",
      factRef: { project_id: projectId, task_id: taskId, artifact_ids: [artifactId] },
    });
    expect(completed.factRef).toEqual({ project_id: projectId, task_id: taskId, artifact_ids: [artifactId] });
  });

  it("rejects project handoffs when either sender or recipient is outside the project roster", async () => {
    const factRef = { project_id: projectId, task_id: taskId, artifact_ids: [] };
    await expect(sendRoleMessage({ connectionString: connectionString! }, {
      tenantId, fromRoleId: outsiderRoleId, toRoleId, body: "forged sender", handoffKind: "task.assigned", factRef,
    })).rejects.toThrow(/sender and recipient must both be project members/);
    await expect(sendRoleMessage({ connectionString: connectionString! }, {
      tenantId, fromRoleId, toRoleId: outsiderRoleId, body: "forged recipient", handoffKind: "task.assigned", factRef,
    })).rejects.toThrow(/sender and recipient must both be project members/);
  });

  it("listRoleMessages filters to a role's inbox and unreadOnly excludes read messages", async () => {
    await pool.query(`DELETE FROM role_messages WHERE tenant_id = $1`, [tenantId]);
    const first = await sendRoleMessage(
      { connectionString: connectionString! },
      { tenantId, fromRoleId, toRoleId, body: "first" },
    );
    await sendRoleMessage(
      { connectionString: connectionString! },
      { tenantId, fromRoleId, toRoleId, body: "second" },
    );

    const inbox = await listRoleMessages({ connectionString: connectionString! }, { tenantId, toRoleId });
    expect(inbox).toHaveLength(2);
    expect(inbox[0]?.body).toBe("second"); // newest-first

    await markRoleMessageRead({ connectionString: connectionString! }, first.messageId);
    const unread = await listRoleMessages(
      { connectionString: connectionString! },
      { tenantId, toRoleId, unreadOnly: true },
    );
    expect(unread.map((m) => m.messageId)).not.toContain(first.messageId);
    expect(unread).toHaveLength(1);
  });

  it("markRoleMessageRead is idempotent: marking twice keeps the original readAt", async () => {
    const sent = await sendRoleMessage(
      { connectionString: connectionString! },
      { tenantId, fromRoleId, toRoleId, body: "idempotent-read" },
    );
    const firstMark = await markRoleMessageRead({ connectionString: connectionString! }, sent.messageId);
    expect(firstMark.readAt).not.toBeNull();

    const secondMark = await markRoleMessageRead({ connectionString: connectionString! }, sent.messageId);
    expect(secondMark.readAt).toEqual(firstMark.readAt);
  });

  it("atomically counts five failed delivery leases, then makes the fifth terminal (TASK-327 liveness)", async () => {
    const sent = await sendRoleMessage(
      { connectionString: connectionString! },
      { tenantId, fromRoleId, toRoleId, body: "retry cap" },
    );
    let finalAttempt;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await claimRoleMessageDelivery({ connectionString: connectionString! }, sent.messageId);
      expect(claimed?.deliveryAttempts).toBe(attempt);
      expect(claimed?.deliveryClaimToken).not.toBeNull();
      finalAttempt = await failRoleMessageDelivery(
        { connectionString: connectionString! }, sent.messageId, claimed!.deliveryClaimToken!, "delivery_error",
      );
      if (attempt < 5) expect(finalAttempt?.readAt).toBeNull();
    }
    expect(finalAttempt).toMatchObject({ deliveryAttempts: 5, lastDeliveryError: "delivery_error" });
    expect(finalAttempt?.readAt).not.toBeNull();
    expect(finalAttempt?.deliveryFailedAt).not.toBeNull();
    expect(await claimRoleMessageDelivery({ connectionString: connectionString! }, sent.messageId)).toBeNull();
  });

  it("markRoleMessageRead throws for an unknown messageId", async () => {
    await expect(
      markRoleMessageRead(
        { connectionString: connectionString! },
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toThrow(/no role_messages row/);
  });
});
