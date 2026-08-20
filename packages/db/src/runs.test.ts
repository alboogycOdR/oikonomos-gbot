import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTask,
  defaultPoolConfig,
  getAuditEventsForRun,
  insertApproval,
  insertAuditEvent,
  listPendingApprovals,
  listRuns,
  startRun,
} from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db runs — listRuns (TASK-061 / OIK-084)", () => {
  let pool: Pool;
  const roleId = "task-061-runs-suite";
  let taskId: string;

  const capabilityId = "task-061.approvals.read";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM approvals WHERE capability_id = $1`, [capabilityId]);
    await pool.query(
      `DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))`,
      [roleId],
    );
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`,
      [roleId],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM capabilities WHERE capability_id = $1`, [capabilityId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    const task = await createTask(
      { connectionString: connectionString! },
      { roleId, title: "runs fixture", goal: "g", requestedBy: "alister" },
    );
    taskId = task.taskId;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("lists runs newest-first, filterable by status and taskId, keyset-paginated", async () => {
    const started = [];
    for (let i = 0; i < 5; i += 1) {
      started.push(
        await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" }),
      );
    }

    const firstPage = await listRuns(
      { connectionString: connectionString! },
      { taskId, status: "started", limit: 2 },
    );
    expect(firstPage.runs).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.runs[0]?.runId).toBe(started[4]?.runId);

    const seen = new Set(firstPage.runs.map((r) => r.runId));
    let cursor = firstPage.nextCursor;
    let guard = 0;
    while (cursor !== null && guard < 10) {
      const page = await listRuns(
        { connectionString: connectionString! },
        { taskId, status: "started", limit: 2, cursor },
      );
      for (const run of page.runs) {
        expect(seen.has(run.runId)).toBe(false);
        seen.add(run.runId);
      }
      cursor = page.nextCursor;
      guard += 1;
    }

    for (const run of started) {
      expect(seen.has(run.runId)).toBe(true);
    }

    const noneForUnrelatedTask = await listRuns(
      { connectionString: connectionString! },
      { taskId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(noneForUnrelatedTask.runs).toHaveLength(0);
    expect(noneForUnrelatedTask.nextCursor).toBeNull();
  });

  it("getAuditEventsForRun is append-only, chronological, and scoped to the requested run (OIK-013)", async () => {
    const run = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    const otherRun = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });

    await insertAuditEvent(
      { connectionString: connectionString! },
      { runId: run.runId, actor: "worker", eventType: "run.started" },
    );
    await insertAuditEvent(
      { connectionString: connectionString! },
      { runId: run.runId, actor: "worker", eventType: "run.completed" },
    );
    await insertAuditEvent(
      { connectionString: connectionString! },
      { runId: otherRun.runId, actor: "worker", eventType: "run.started" },
    );

    const events = await getAuditEventsForRun({ connectionString: connectionString! }, run.runId);
    expect(events.map((e) => e.eventType)).toEqual(["run.started", "run.completed"]);
    expect(events.every((e) => e.runId === run.runId)).toBe(true);

    // OIK-013 append-only: the schema's `ON UPDATE ... DO INSTEAD NOTHING`
    // rule silently no-ops an UPDATE rather than erroring, and this module
    // deliberately adds no UPDATE/DELETE statement of its own.
    await pool.query(`UPDATE audit_events SET event_type = 'tampered' WHERE run_id = $1`, [
      run.runId,
    ]);
    const afterAttemptedUpdate = await getAuditEventsForRun(
      { connectionString: connectionString! },
      run.runId,
    );
    expect(afterAttemptedUpdate.map((e) => e.eventType)).toEqual(["run.started", "run.completed"]);

    const noEvents = await getAuditEventsForRun(
      { connectionString: connectionString! },
      otherRun.runId,
    );
    expect(noEvents.map((e) => e.eventType)).toEqual(["run.started"]);
  });

  it("listPendingApprovals returns only pending, unexpired approvals (never granted/expired/consumed)", async () => {
    await pool.query(
      `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled)
       VALUES ($1, 'TASK-061 fixture', 'T1_draft', 'test', true)
       ON CONFLICT (capability_id) DO NOTHING`,
      [capabilityId],
    );
    const run = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);

    const pending = await insertApproval(
      { connectionString: connectionString! },
      {
        runId: run.runId,
        capabilityId,
        actionDigest: new Uint8Array([1, 2, 3]),
        actionRender: "send email",
        destination: "ops@basileia",
        expiresAt: future,
      },
    );
    const expired = await insertApproval(
      { connectionString: connectionString! },
      {
        runId: run.runId,
        capabilityId,
        actionDigest: new Uint8Array([4, 5, 6]),
        actionRender: "send email (expired)",
        destination: "ops@basileia",
        expiresAt: past,
      },
    );
    const granted = await insertApproval(
      { connectionString: connectionString! },
      {
        runId: run.runId,
        capabilityId,
        actionDigest: new Uint8Array([7, 8, 9]),
        actionRender: "send email (granted)",
        destination: "ops@basileia",
        expiresAt: future,
      },
    );
    await pool.query(`UPDATE approvals SET status = 'granted' WHERE approval_id = $1`, [
      granted.approvalId,
    ]);

    const result = await listPendingApprovals({ connectionString: connectionString! });
    const ids = result.map((a) => a.approvalId);
    expect(ids).toContain(pending.approvalId);
    expect(ids).not.toContain(expired.approvalId);
    expect(ids).not.toContain(granted.approvalId);
    expect(result.every((a) => a.status === "pending")).toBe(true);
    expect(result.every((a) => a.expiresAt.getTime() > Date.now())).toBe(true);
  });
});
