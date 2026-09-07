import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { grantApproval, issueApproval, verifyAndConsume } from "@oikonomos/approvals";
import { Database, getAuditEventsForRun, getRun, listPendingApprovals, type DatabaseOptions } from "@oikonomos/db";

import {
  APPROVAL_ABANDONED_EVENT_TYPE,
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

integration("@oikonomos/worker durable resume vs. pending approvals (TASK-135 / OIK-107)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let pool: Pool;
  let taskId: string;
  const capabilityId = "test.governed_tool.oik-107";

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString! });
    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      ["inbox-triage", "TASK-135 worker fixture", "exercise resume vs. pending approvals", "test:task-135-worker"],
    );
    const insertedTaskId = task.rows[0]?.task_id;
    if (insertedTaskId === undefined) {
      throw new Error("failed to insert TASK-135 worker fixture task");
    }
    taskId = insertedTaskId;

    // The `approvals.capability_id` FK requires a real capabilities row.
    // Same upsert-not-migration pattern chatRunDriver.ts already uses for
    // `chat.bot_fanout` (a governed action with no connector manifest).
    const database = new Database(options);
    try {
      await database.upsertCapability({
        capabilityId,
        description: "OIK-107 fixture: a T2 tool whose side effect must run at most once.",
        defaultTier: "T2_internal",
        adapter: "test:governed-tool",
        enabled: true,
      });
    } finally {
      await database.close();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it(
    "resuming a run parked mid-approval-wait never re-invokes the governed tool, and the original nonce still completes the run",
    async () => {
      // 1. A real run reaches an external-effect tool call that requires
      // approval. The broker denies *before* the tool's side effect runs
      // (ADR-001 PreToolUse gating) — modelled here by a call counter that
      // must stay at 0 until the approval is actually granted and
      // consumed. `invokeGovernedTool` stands in for the real adapter body
      // (e.g. "send the email") that only ever runs on a successful
      // `verifyAndConsume`.
      let sideEffectInvocations = 0;
      const invokeGovernedTool = (): void => {
        sideEffectInvocations += 1;
      };

      const run = await startTaskRun(options, {
        taskId,
        provider: "claude-code",
        sessionRef: "oik-107-session-1",
      });
      expect(run.status).toBe("started");

      // The tool call attempt that produced the pending approval. Issuing
      // the approval is the entire effect of a denied, gated call — the
      // governed side effect itself is not invoked yet.
      const waitSignal = await issueApproval(
        {
          runId: run.runId,
          capabilityId,
          toolName: "test.governed_tool",
          input: { action: "send", target: "ops@basileia.example" },
          destination: "ops@basileia.example",
        },
        { database: options },
      );
      expect(waitSignal.status).toBe("pending");
      expect(sideEffectInvocations).toBe(0);

      // The worker parks the run at `waiting_approval` while the human
      // decides (chatRunDriver.ts does not yet wire a RunParkPort that
      // performs this transition in production — see the dossier's
      // "Production wiring gap" note; constructing the persisted state
      // directly here matches TASK-133's own established convention for
      // simulating a killed process without actually killing one).
      const parked = await pool.query(
        `UPDATE runs SET status = 'waiting_approval' WHERE run_id = $1`,
        [run.runId],
      );
      expect(parked.rowCount).toBe(1);
      const beforeReconcile = await getRun(options, run.runId);
      expect(beforeReconcile?.status).toBe("waiting_approval");

      // 2. The worker process is killed (not actually killed — this is
      // the same testing convention TASK-133 established) and a fresh
      // process boots and reconciles orphaned runs.
      const outcomes = await reconcileInterruptedRuns(options, { taskId });
      const mine = outcomes.find((outcome) => outcome.runId === run.runId);
      expect(mine).toEqual({ runId: run.runId, outcome: "resumed" });

      const afterReconcile = await getRun(options, run.runId);
      expect(afterReconcile?.status).toBe("resumed");
      expect(afterReconcile?.sessionRef).toBe("oik-107-session-1");

      // The proof AC1 actually cares about: reconciliation is a pure
      // `@oikonomos/db` status transition (`reconcileInterruptedRuns` /
      // `resumeInterruptedRun` import nothing from the harness, the
      // broker, or any tool adapter — see runLifecycle.ts's import list)
      // and therefore cannot have invoked the governed tool a second
      // time. Not "no error was thrown" — the actual call counter proves
      // it stayed at zero across the entire resume.
      expect(sideEffectInvocations).toBe(0);

      // The pending approval itself is untouched by reconciliation — same
      // nonce, still pending.
      const pendingRow = await pool.query<{ status: string; nonce: string }>(
        `SELECT status, nonce::text AS nonce FROM approvals WHERE nonce = $1`,
        [waitSignal.nonce],
      );
      expect(pendingRow.rows[0]?.status).toBe("pending");
      expect(pendingRow.rows[0]?.nonce).toBe(waitSignal.nonce);

      // 3. AC2 — the *original* approval nonce (issued before the worker
      // died) is still the one that completes the run: a human grants it,
      // and consuming it is what finally runs the governed side effect
      // exactly once.
      const granted = await grantApproval(waitSignal.nonce, "human:reviewer-1", { database: options });
      expect(granted.decided).toBe(true);
      if (granted.decided) {
        expect(granted.approval.status).toBe("granted");
      }

      const consumed = await verifyAndConsume(waitSignal.nonce, { database: options });
      expect(consumed.consumed).toBe(true);
      if (consumed.consumed) {
        invokeGovernedTool();
        expect(consumed.approval.runId).toBe(run.runId);
      }
      expect(sideEffectInvocations).toBe(1);

      const completed = await completeTaskRun(options, run.runId);
      expect(completed.status).toBe("completed");

      // Single-use, still: replaying the very same nonce after the run
      // has already completed must not consume again or re-invoke the
      // tool a second time (the exact double-execution risk OIK-107
      // names).
      const replay = await verifyAndConsume(waitSignal.nonce, { database: options });
      expect(replay.consumed).toBe(false);
      expect(sideEffectInvocations).toBe(1);
    },
  );

  it("a completed run's already-consumed approval is never re-fetched by reconciliation (mutation-proof companion to the terminal-run test)", async () => {
    const run = await startTaskRun(options, { taskId, provider: "claude-code" });
    const waitSignal = await issueApproval(
      {
        runId: run.runId,
        capabilityId,
        toolName: "test.governed_tool",
        input: { action: "send", target: "ops@basileia.example" },
        destination: "ops@basileia.example",
      },
      { database: options },
    );
    await grantApproval(waitSignal.nonce, "human:reviewer-1", { database: options });
    await verifyAndConsume(waitSignal.nonce, { database: options });
    await completeTaskRun(options, run.runId);

    const outcomes = await reconcileInterruptedRuns(options, { taskId });
    expect(outcomes.some((outcome) => outcome.runId === run.runId)).toBe(false);

    const replay = await verifyAndConsume(waitSignal.nonce, { database: options });
    expect(replay.consumed).toBe(false);
  });

  // TASK-218 — reported by a user from the mobile client, then confirmed in
  // the database: a run requested an approval at 10:52:52, COMPLETED at
  // 10:57:27, and the operator granted it at 10:59:57 — two and a half
  // minutes after there was anything left to resume. The card stayed
  // actionable and answering it did nothing.
  it("leaves a completed run's pending approval ALONE — that is the undecided fork (TASK-218)", async () => {
    const run = await startTaskRun(options, { taskId, provider: "claude-code" });
    await issueApproval(
      {
        runId: run.runId,
        capabilityId,
        toolName: "test.governed_tool",
        input: { action: "send", target: "ops@basileia.example" },
        destination: "ops@basileia.example",
      },
      { database: options },
    );
    expect(await listPendingApprovals(options, { runId: run.runId, includeExpired: true })).toHaveLength(1);

    await completeTaskRun(options, run.runId);

    // A completed run's pending approval may be the reported dead end, or a
    // run awaiting the answer TASK-155 would resume it with. Voiding it here
    // would decide the park-vs-rerun fork by implication AND break the
    // working approval flow — which is exactly how the TASK-136 test caught
    // an earlier, more aggressive version of this change.
    expect(await listPendingApprovals(options, { runId: run.runId, includeExpired: true })).toHaveLength(1);
  });

  it("voids a cancelled run's pending approval, and says the run ended underneath it (TASK-218)", async () => {
    const run = await startTaskRun(options, { taskId, provider: "claude-code" });
    await issueApproval(
      {
        runId: run.runId,
        capabilityId,
        toolName: "test.governed_tool",
        input: { action: "send", target: "ops@basileia.example" },
        destination: "ops@basileia.example",
      },
      { database: options },
    );

    await cancelTaskRun(options, run.runId);

    expect(await listPendingApprovals(options, { runId: run.runId, includeExpired: true })).toHaveLength(0);
    // The audit trail must never suggest the operator turned it down.
    // Misreporting a person's decision is worse than the dangling card.
    const events = await getAuditEventsForRun(options, run.runId);
    const abandoned = events.filter((event) => event.eventType === APPROVAL_ABANDONED_EVENT_TYPE);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.actor).toBe("system:run-lifecycle");
  });

  it("does the same when a run fails, not only when it completes (TASK-218)", async () => {
    const run = await startTaskRun(options, { taskId, provider: "claude-code" });
    await issueApproval(
      {
        runId: run.runId,
        capabilityId,
        toolName: "test.governed_tool",
        input: { action: "send", target: "ops@basileia.example" },
        destination: "ops@basileia.example",
      },
      { database: options },
    );

    await failTaskRun(options, run.runId, "provider unavailable");

    expect(await listPendingApprovals(options, { runId: run.runId, includeExpired: true })).toHaveLength(0);
  });

  it("never lets approval tidy-up turn a finished run into a failed one (TASK-218)", async () => {
    // A run that genuinely completed must still be reported as completed even
    // if its housekeeping cannot run.
    const run = await startTaskRun(options, { taskId, provider: "claude-code" });
    const broken = { connectionString: "postgres://nobody@127.0.0.1:1/none" } as DatabaseOptions;

    const { resolveDanglingApprovals } = await import("../src/runLifecycle.js");
    await expect(resolveDanglingApprovals(broken, { ...run, status: "completed" } as never)).resolves.toBe(0);

    const completed = await completeTaskRun(options, run.runId);
    expect(completed.status).toBe("completed");
  });
});
