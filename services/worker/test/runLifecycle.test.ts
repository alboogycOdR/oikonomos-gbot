import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRun, type DatabaseOptions } from "@oikonomos/db";

import {
  cancelTaskRun,
  failTaskRun,
  resumeInterruptedRun,
  startTaskRun,
} from "../src/runLifecycle.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("@oikonomos/worker runLifecycle (TASK-034 / OIK-038)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let pool: Pool;
  let taskId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString! });
    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      ["inbox-triage", "TASK-034 worker fixture", "exercise runLifecycle", "test:task-034-worker"],
    );
    const insertedTaskId = task.rows[0]?.task_id;
    if (insertedTaskId === undefined) {
      throw new Error("failed to insert TASK-034 worker fixture task");
    }
    taskId = insertedTaskId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("drives start -> resumeInterruptedRun end to end through the @oikonomos/db barrel", async () => {
    const started = await startTaskRun(options, {
      taskId,
      provider: "claude-code",
      sessionRef: "worker-session-1",
    });
    expect(started.status).toBe("started");

    // A fresh worker process (this call) re-derives the session_ref from
    // the database rather than trusting in-memory state — the resume path
    // a real process-kill recovery would take.
    const resumed = await resumeInterruptedRun(options, started.runId);
    expect(resumed.status).toBe("resumed");
    expect(resumed.sessionRef).toBe("worker-session-1");

    const persisted = await getRun(options, started.runId);
    expect(persisted?.status).toBe("resumed");
    expect(persisted?.sessionRef).toBe("worker-session-1");
  });

  it("resumeInterruptedRun rejects an unknown run_id", async () => {
    await expect(
      resumeInterruptedRun(options, "11111111-1111-1111-1111-111111111111"),
    ).rejects.toThrow();
  });

  it("failTaskRun and cancelTaskRun delegate to @oikonomos/db and persist", async () => {
    const started = await startTaskRun(options, { taskId, provider: "codex" });
    const failed = await failTaskRun(options, started.runId, "worker crashed");
    expect(failed.status).toBe("failed");
    expect(failed.failureNote).toBe("worker crashed");

    const other = await startTaskRun(options, { taskId, provider: "grok-build" });
    const cancelled = await cancelTaskRun(options, other.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});
