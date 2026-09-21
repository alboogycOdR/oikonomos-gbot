import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { admitProjectFanout, getAuditEventsForRun } from "./auditEvents.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("project fanout audit admission (TASK-321)", () => {
  const options = { connectionString: connectionString! };

  it("serializes concurrent admissions per run, audits refusals, and leaves another run independent", async () => {
    const projectId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const inputs = Array.from({ length: 4 }, () => ({
      tenantId: `task-321-${randomUUID()}`,
      runId,
      actor: "agent:task-321-manager",
      projectId,
      taskId: randomUUID(),
      ownerRoleId: "task-321-member",
      rosterSize: 3,
    }));

    const results = await Promise.all(inputs.map((input) => admitProjectFanout(options, input)));
    expect(results.filter((result) => result.admitted)).toHaveLength(3);
    expect((await getAuditEventsForRun(options, runId)).map((event) => event.eventType).sort()).toEqual([
      "project.fanout_capped", "project.task_assigned", "project.task_assigned", "project.task_assigned",
    ]);
    await expect(admitProjectFanout(options, { ...inputs[0]!, runId: otherRunId, taskId: randomUUID() })).resolves.toMatchObject({ admitted: true, assignmentCount: 0 });
  });
});
