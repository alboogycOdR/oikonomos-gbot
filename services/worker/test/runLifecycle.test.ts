import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRun, type DatabaseOptions } from "@oikonomos/db";

import {
  cancelTaskRun,
  completeTaskRun,
  failTaskRun,
  reconcileInterruptedRuns,
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

integration("@oikonomos/worker reconcileInterruptedRuns (TASK-133 / OIK-106)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let pool: Pool;
  let taskId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString! });
    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      ["inbox-triage", "TASK-133 worker fixture", "exercise reconcileInterruptedRuns", "test:task-133-worker"],
    );
    const insertedTaskId = task.rows[0]?.task_id;
    if (insertedTaskId === undefined) {
      throw new Error("failed to insert TASK-133 worker fixture task");
    }
    taskId = insertedTaskId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("finds a run left in an open status (simulating a killed process) and resumes it", async () => {
    // Construct the persisted state directly rather than actually killing a
    // process (per the task's own instruction): a `started` run with no
    // live process behind it is indistinguishable, from the database's
    // point of view, from one orphaned by a real process death.
    const orphan = await startTaskRun(options, {
      taskId,
      provider: "claude-code",
      sessionRef: "reconcile-session-1",
    });
    expect(orphan.status).toBe("started");

    const outcomes = await reconcileInterruptedRuns(options, { taskId });
    const mine = outcomes.find((o) => o.runId === orphan.runId);
    expect(mine).toEqual({ runId: orphan.runId, outcome: "resumed" });

    const persisted = await getRun(options, orphan.runId);
    expect(persisted?.status).toBe("resumed");
    expect(persisted?.sessionRef).toBe("reconcile-session-1");
  });

  it("never touches a completed/failed/cancelled run (mutation-proof: a broken status filter would resume a terminal run)", async () => {
    const completedRun = await startTaskRun(options, { taskId, provider: "claude-code" });
    await completeTaskRun(options, completedRun.runId);

    const failedRun = await startTaskRun(options, { taskId, provider: "claude-code" });
    await failTaskRun(options, failedRun.runId, "worker crashed");

    const cancelledRun = await startTaskRun(options, { taskId, provider: "claude-code" });
    await cancelTaskRun(options, cancelledRun.runId);

    const outcomes = await reconcileInterruptedRuns(options, { taskId });
    const touchedIds = new Set(outcomes.map((o) => o.runId));

    // If the reconciliation scan's status filter were removed (matching
    // every run regardless of status), these three terminal runs would be
    // fetched and resumeInterruptedRun would be attempted on each —
    // resumeRun's own `WHERE status IN (...)` would then reject the
    // attempt, but reconcileInterruptedRuns would still have *tried* to
    // touch them (a "resume_failed" outcome), which this assertion catches.
    expect(touchedIds.has(completedRun.runId)).toBe(false);
    expect(touchedIds.has(failedRun.runId)).toBe(false);
    expect(touchedIds.has(cancelledRun.runId)).toBe(false);

    const completedAfter = await getRun(options, completedRun.runId);
    const failedAfter = await getRun(options, failedRun.runId);
    const cancelledAfter = await getRun(options, cancelledRun.runId);
    expect(completedAfter?.status).toBe("completed");
    expect(failedAfter?.status).toBe("failed");
    expect(cancelledAfter?.status).toBe("cancelled");
  });

  it("is callable independently of any worker-process boot sequence (AC3): a bare call against real Postgres just works", async () => {
    await expect(reconcileInterruptedRuns(options, { taskId })).resolves.toBeInstanceOf(Array);
  });
});
