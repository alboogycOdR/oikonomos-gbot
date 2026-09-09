import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordAuditEvent } from "@oikonomos/audit";
import { getRun, type DatabaseOptions } from "@oikonomos/db";

import { startTaskRun } from "./runLifecycle.js";
import { completeTakeover, getTakeoverState, TAKEOVER_COMPLETED_EVENT_TYPE } from "./takeover.js";

const HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE = "run.human_takeover_required";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("takeover — worker-side takeover state and hand-back (TASK-188 / G-07)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let pool: Pool;
  let taskId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString! });
    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      ["inbox-triage", "TASK-188 worker fixture", "exercise takeover state/hand-back", "test:task-188-worker"],
    );
    const insertedTaskId = task.rows[0]?.task_id;
    if (insertedTaskId === undefined) throw new Error("failed to insert TASK-188 worker fixture task");
    taskId = insertedTaskId;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function parkForTakeover(sessionRef: string | null, kind = "captcha", detail = "detected captcha page") {
    const run = await startTaskRun(options, { taskId, provider: "claude-code", ...(sessionRef === null ? {} : { sessionRef }) });
    await pool.query("UPDATE runs SET status = 'waiting_approval' WHERE run_id = $1", [run.runId]);
    await recordAuditEvent(options, {
      tenantId: run.tenantId,
      runId: run.runId,
      actor: "agent:claude",
      eventType: HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE,
      payload: { kind, detail },
    });
    return run;
  }

  it("a run parked with no human_takeover_required event is NOT pending — an ordinary approval park looks identical at the status level", async () => {
    const run = await startTaskRun(options, { taskId, provider: "claude-code", sessionRef: "s1" });
    await pool.query("UPDATE runs SET status = 'waiting_approval' WHERE run_id = $1", [run.runId]);

    const state = await getTakeoverState(options, run.runId);
    expect(state).toEqual({ runId: run.runId, pending: false });
  });

  it("a run that never parked at all is NOT pending", async () => {
    const run = await startTaskRun(options, { taskId, provider: "claude-code", sessionRef: "s2" });
    const state = await getTakeoverState(options, run.runId);
    expect(state).toEqual({ runId: run.runId, pending: false });
  });

  it("a run parked with a real human_takeover_required event IS pending, with the real kind/detail", async () => {
    const run = await parkForTakeover("s3", "two_factor", "detected two factor page");
    const state = await getTakeoverState(options, run.runId);
    expect(state).toEqual({ runId: run.runId, pending: true, kind: "two_factor", detail: "detected two factor page" });
  });

  it("completeTakeover records the completed event and resumes the run through resumeInterruptedRun", async () => {
    const run = await parkForTakeover("s4");
    const outcome = await completeTakeover(options, run.runId);
    expect(outcome).toMatchObject({ completed: true });
    if (!outcome.completed) throw new Error("expected completed: true");
    expect(outcome.run.status).toBe("resumed");
    expect(outcome.run.sessionRef).toBe("s4");

    const persisted = await getRun(options, run.runId);
    expect(persisted?.status).toBe("resumed");

    // mutation-proof companion below asserts this is really the guard, not
    // an accident of resumeInterruptedRun's own idempotency.
    const completedEvent = (await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM audit_events WHERE run_id = $1 AND event_type = $2",
      [run.runId, TAKEOVER_COMPLETED_EVENT_TYPE],
    )).rows[0];
    expect(completedEvent?.payload).toMatchObject({ kind: "captcha" });
  });

  it("completeTakeover refuses (not_pending) a run that is not parked for a takeover at all", async () => {
    const run = await startTaskRun(options, { taskId, provider: "claude-code", sessionRef: "s5" });
    const outcome = await completeTakeover(options, run.runId);
    expect(outcome).toEqual({ completed: false, reason: "not_pending" });
  });

  it("completeTakeover refuses (not_pending) a takeover that was already completed — no double-resume, no double audit event", async () => {
    const run = await parkForTakeover("s6");
    const first = await completeTakeover(options, run.runId);
    expect(first.completed).toBe(true);

    // The run is 'resumed' now, not 'waiting_approval' — a second call must
    // see that and refuse, not blindly re-resume or re-record.
    const second = await completeTakeover(options, run.runId);
    expect(second).toEqual({ completed: false, reason: "not_pending" });

    const completedEvents = await pool.query(
      "SELECT event_id FROM audit_events WHERE run_id = $1 AND event_type = $2",
      [run.runId, TAKEOVER_COMPLETED_EVENT_TYPE],
    );
    expect(completedEvents.rowCount).toBe(1);
  });

  it("completeTakeover refuses (cannot_resume) a genuinely takeover-parked run with no session_ref — never resumes into an unusable state", async () => {
    const run = await parkForTakeover(null);
    const outcome = await completeTakeover(options, run.runId);
    expect(outcome).toEqual({ completed: false, reason: "cannot_resume" });

    // Left parked, not silently marked resumed/failed.
    const persisted = await getRun(options, run.runId);
    expect(persisted?.status).toBe("waiting_approval");
  });

  it(
    "MUTATION-PROOF: a human_takeover_completed event strictly BEFORE the most recent human_takeover_required " +
      "still leaves the run pending — a second, later takeover after a completed first one is not masked by the first's own record",
    async () => {
      const run = await parkForTakeover("s7", "captcha", "first captcha");
      const firstComplete = await completeTakeover(options, run.runId);
      expect(firstComplete.completed).toBe(true);

      // The run parks AGAIN for a second, later takeover — constructed
      // directly (matching this file's own established convention) rather
      // than driving a second real navigate.
      await pool.query("UPDATE runs SET status = 'waiting_approval' WHERE run_id = $1", [run.runId]);
      await recordAuditEvent(options, {
        tenantId: run.tenantId,
        runId: run.runId,
        actor: "agent:claude",
        eventType: HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE,
        payload: { kind: "payment", detail: "second, later payment page" },
      });

      const state = await getTakeoverState(options, run.runId);
      expect(state).toEqual({ runId: run.runId, pending: true, kind: "payment", detail: "second, later payment page" });
    },
  );
});
