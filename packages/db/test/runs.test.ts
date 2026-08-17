import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cancelRun,
  defaultPoolConfig,
  failRun,
  getRun,
  IllegalRunTransitionError,
  resumeRun,
  RunNotFoundError,
  startRun,
  type DatabaseOptions,
} from "../src/index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("runs lifecycle persistence (TASK-034 / OIK-038)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let pool: Pool;
  let taskId: string;

  async function insertFixtureTask(): Promise<string> {
    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      ["inbox-triage", "TASK-034 run fixture", "round-trip a run row", "test:task-034"],
    );
    const insertedTaskId = task.rows[0]?.task_id;
    if (insertedTaskId === undefined) {
      throw new Error("failed to insert TASK-034 fixture task");
    }
    return insertedTaskId;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    taskId = await insertFixtureTask();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("starts a run with status 'started' and a null session_ref by default", async () => {
    const run = await startRun(options, { taskId, provider: "claude-code" });

    expect(run.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(run.taskId).toBe(taskId);
    expect(run.tenantId).toBe("basileia");
    expect(run.provider).toBe("claude-code");
    expect(run.sessionRef).toBeNull();
    expect(run.status).toBe("started");
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.endedAt).toBeNull();
    expect(run.failureNote).toBeNull();

    const fetched = await getRun(options, run.runId);
    expect(fetched).toEqual(run);
  });

  it("starts a run with an explicit session_ref and tenantId", async () => {
    const run = await startRun(options, {
      taskId,
      provider: "codex",
      tenantId: "basileia",
      sessionRef: "harness-session-abc",
    });
    expect(run.sessionRef).toBe("harness-session-abc");
  });

  it("resume after a killed process persists and returns the correct state (AC1)", async () => {
    // Simulate: a run starts with a harness session id, the process is
    // killed, and a fresh worker resumes it by reading the persisted
    // session_ref back and handing it to resumeRun.
    const started = await startRun(options, {
      taskId,
      provider: "claude-code",
      sessionRef: "harness-session-xyz",
    });

    // "process kill" — nothing more happens to `started` in-memory; a new
    // reader re-fetches from the DB, exactly as a fresh worker process would.
    const readBack = await getRun(options, started.runId);
    expect(readBack).not.toBeNull();

    const resumed = await resumeRun(options, started.runId, readBack!.sessionRef ?? undefined);
    expect(resumed.status).toBe("resumed");
    expect(resumed.sessionRef).toBe("harness-session-xyz");
    expect(resumed.runId).toBe(started.runId);

    // The persisted state now reflects 'resumed' with the same session_ref.
    const final = await getRun(options, started.runId);
    expect(final?.status).toBe("resumed");
    expect(final?.sessionRef).toBe("harness-session-xyz");
  });

  it("resume without a sessionRef preserves the previously stored one", async () => {
    const started = await startRun(options, {
      taskId,
      provider: "claude-code",
      sessionRef: "keep-me",
    });

    const resumed = await resumeRun(options, started.runId);
    expect(resumed.status).toBe("resumed");
    expect(resumed.sessionRef).toBe("keep-me");
  });

  it("resume is idempotent across repeated kill/resume cycles", async () => {
    const started = await startRun(options, { taskId, provider: "claude-code" });

    const firstResume = await resumeRun(options, started.runId, "session-1");
    expect(firstResume.status).toBe("resumed");

    const secondResume = await resumeRun(options, started.runId, "session-2");
    expect(secondResume.status).toBe("resumed");
    expect(secondResume.sessionRef).toBe("session-2");
  });

  it("fails a run, setting ended_at and failure_note", async () => {
    const started = await startRun(options, { taskId, provider: "grok-build" });

    const failed = await failRun(options, started.runId, "harness crashed: OOM");
    expect(failed.status).toBe("failed");
    expect(failed.failureNote).toBe("harness crashed: OOM");
    expect(failed.endedAt).toBeInstanceOf(Date);
  });

  it("cancels a run, setting ended_at", async () => {
    const started = await startRun(options, { taskId, provider: "grok-build" });

    const cancelled = await cancelRun(options, started.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.endedAt).toBeInstanceOf(Date);
  });

  it("cancels a run that is waiting_approval", async () => {
    const started = await startRun(options, { taskId, provider: "codex" });
    await pool.query(`UPDATE runs SET status = 'waiting_approval' WHERE run_id = $1`, [
      started.runId,
    ]);

    const cancelled = await cancelRun(options, started.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("rejects resume on a completed run (illegal transition)", async () => {
    const started = await startRun(options, { taskId, provider: "codex" });
    await pool.query(`UPDATE runs SET status = 'completed' WHERE run_id = $1`, [started.runId]);

    await expect(resumeRun(options, started.runId)).rejects.toThrow(IllegalRunTransitionError);
    await expect(resumeRun(options, started.runId)).rejects.toMatchObject({
      fromStatus: "completed",
      action: "resume",
    });
  });

  it("rejects fail on an already-failed run (illegal transition)", async () => {
    const started = await startRun(options, { taskId, provider: "codex" });
    await failRun(options, started.runId, "first failure");

    await expect(failRun(options, started.runId, "second failure")).rejects.toThrow(
      IllegalRunTransitionError,
    );
  });

  it("rejects cancel on an already-cancelled run (illegal transition)", async () => {
    const started = await startRun(options, { taskId, provider: "codex" });
    await cancelRun(options, started.runId);

    await expect(cancelRun(options, started.runId)).rejects.toThrow(IllegalRunTransitionError);
  });

  it("rejects a transition on an unknown run_id with RunNotFoundError", async () => {
    const unknownRunId = randomUUID();

    await expect(resumeRun(options, unknownRunId)).rejects.toThrow(RunNotFoundError);
    await expect(failRun(options, unknownRunId, "n/a")).rejects.toThrow(RunNotFoundError);
    await expect(cancelRun(options, unknownRunId)).rejects.toThrow(RunNotFoundError);
  });

  it("returns null from getRun for an unknown run_id instead of throwing", async () => {
    await expect(getRun(options, randomUUID())).resolves.toBeNull();
  });

  it("does not add or alter run_status enum values (AC2)", async () => {
    const result = await pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
       WHERE pg_type.typname = 'run_status'
       ORDER BY enumsortorder`,
    );
    expect(result.rows.map((row) => row.enumlabel)).toEqual([
      "started",
      "waiting_approval",
      "resumed",
      "completed",
      "failed",
      "cancelled",
    ]);
  });
});
