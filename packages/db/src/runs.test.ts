import { readFileSync } from "node:fs";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  completeRun,
  createTask,
  createTaskExecutionRun,
  defaultPoolConfig,
  getAuditEventsForRun,
  getRun,
  IllegalRunTransitionError,
  insertApproval,
  insertAuditEvent,
  listPendingApprovals,
  listRuns,
  resumeRun,
  startFreshEpoch,
  startRun,
  type TaskExecution,
} from "./index.js";

// TASK-270 rework: `createTaskExecutionRun`'s `execution` param has no
// `epoch` field of its own (see ports.ts's matching doc comment) -- these
// fixtures stamp it the same way `submitTaskExecution` does in production,
// so `getLatestRunForThread`'s epoch scoping has something real to match.
type StampedExecution = TaskExecution & { epoch: number };
// `listOpenRuns`/`openRunStatuses` (OIK-106) and `getLatestRunForThread`
// (TASK-269) are new and not yet re-exported from the package barrel
// (`index.ts` is outside this file's `Owned_Paths` — see the TASK-269
// dossier; the identical gap for `listOpenRuns` was hit and resolved the
// same way in OIK-106) — imported directly from the module instead.
import { failRun, cancelRun, getLatestRunForThread, getThreadEpoch, listOpenRuns, openRunStatuses, parkRun } from "./runs.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
// Each integration test performs database work sequentially. Keep its
// connection demand small while workspace packages run against shared Postgres.
const integrationPoolConfig = { ...defaultPoolConfig, max: 1 };
const integrationOptions = { connectionString: connectionString ?? "", poolConfig: { max: 1 } };

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
    pool = new Pool({ connectionString: connectionString!, ...integrationPoolConfig });
    await cleanup();
    const task = await createTask(
      integrationOptions,
      { roleId, title: "runs fixture", goal: "g", requestedBy: "alister" },
    );
    taskId = task.taskId;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("lists runs newest-first, filterable by status and taskId, keyset-paginated, tiebreaking a shared started_at via run_id DESC", async () => {
    const started = [];
    for (let i = 0; i < 5; i += 1) {
      started.push(
        await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" }),
      );
    }

    // Force two independent, REAL started_at ties, each straddling a page
    // boundary (limit=2: pages are [4,3][2,1][0]) — see the identical,
    // rationale-documented fixture in `tasks.test.ts` (TASK-061 review
    // round 1 finding: an untested `run_id DESC` tiebreaker, plus the
    // `.toISOString()` cursor-precision bug it uncovered, both fixed
    // there and mirrored here since `listRuns` shares the exact pattern).
    await pool.query(
      `UPDATE runs SET started_at = (SELECT started_at FROM runs WHERE run_id = $1)
       WHERE run_id = $2`,
      [started[2]!.runId, started[3]!.runId],
    );
    const [tieALoser, tieAWinner] = [started[2]!.runId, started[3]!.runId].sort();
    await pool.query(
      `UPDATE runs SET started_at = (SELECT started_at FROM runs WHERE run_id = $1)
       WHERE run_id = $2`,
      [started[0]!.runId, started[1]!.runId],
    );
    const [tieBLoser, tieBWinner] = [started[0]!.runId, started[1]!.runId].sort();

    const firstPage = await listRuns(
      { connectionString: connectionString! },
      { taskId, status: "started", limit: 2 },
    );
    expect(firstPage.runs).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.runs[0]?.runId).toBe(started[4]?.runId);
    expect(firstPage.runs[1]?.runId).toBe(tieAWinner);

    const seen = new Set(firstPage.runs.map((r) => r.runId));
    let cursor = firstPage.nextCursor;
    let guard = 0;
    let pageIndex = 0;
    while (cursor !== null && guard < 10) {
      const page = await listRuns(
        { connectionString: connectionString! },
        { taskId, status: "started", limit: 2, cursor },
      );
      if (pageIndex === 0) {
        expect(page.runs[0]?.runId).toBe(tieALoser);
        expect(page.runs[1]?.runId).toBe(tieBWinner);
      }
      if (pageIndex === 1) {
        expect(page.runs[0]?.runId).toBe(tieBLoser);
      }
      for (const run of page.runs) {
        expect(seen.has(run.runId)).toBe(false);
        seen.add(run.runId);
      }
      cursor = page.nextCursor;
      guard += 1;
      pageIndex += 1;
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

// TASK-116: completeRun had zero test coverage (a live production run was
// independently verified by ORCH against real Postgres for TASK-111, but
// nothing here would catch a future regression). Mirrors this file's own
// `listRuns`/`listPendingApprovals` integration shape: real Postgres, a
// dedicated role_id fixture, cleaned up in afterAll.
integration("packages/db runs — completeRun (TASK-116)", () => {
  let pool: Pool;
  const roleId = "task-116-runs-completeRun-suite";
  let taskId: string;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`,
      [roleId],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...integrationPoolConfig });
    await cleanup();
    const task = await createTask(
      integrationOptions,
      { roleId, title: "completeRun fixture", goal: "g", requestedBy: "alister" },
    );
    taskId = task.taskId;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("transitions a started run to 'completed' with ended_at set", async () => {
    const run = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    expect(run.status).toBe("started");
    expect(run.endedAt).toBeNull();

    const completed = await completeRun({ connectionString: connectionString! }, run.runId);
    expect(completed.runId).toBe(run.runId);
    expect(completed.status).toBe("completed");
    expect(completed.endedAt).not.toBeNull();
    expect(completed.endedAt!.getTime()).toBeGreaterThanOrEqual(run.startedAt.getTime());
  });

  it("throws IllegalRunTransitionError when completing an already-terminal run", async () => {
    const run = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    await completeRun({ connectionString: connectionString! }, run.runId);

    await expect(
      completeRun({ connectionString: connectionString! }, run.runId),
    ).rejects.toThrow(IllegalRunTransitionError);
    await expect(
      completeRun({ connectionString: connectionString! }, run.runId),
    ).rejects.toMatchObject({ runId: run.runId, fromStatus: "completed" });
  });
});

// TASK-133 / OIK-106: listOpenRuns is the accessor a boot-time worker
// reconciliation step uses to find runs orphaned by a killed process.
integration("packages/db runs — listOpenRuns (TASK-133 / OIK-106)", () => {
  let pool: Pool;
  const roleId = "task-133-listopenruns-suite";
  let taskId: string;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`,
      [roleId],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...integrationPoolConfig });
    await cleanup();
    const task = await createTask(
      integrationOptions,
      { roleId, title: "listOpenRuns fixture", goal: "g", requestedBy: "alister" },
    );
    taskId = task.taskId;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("returns only runs in an open status (started/waiting_approval/resumed), never a terminal one", async () => {
    const started = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    const resumed = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    await pool.query(`UPDATE runs SET status = 'waiting_approval' WHERE run_id = $1`, [
      resumed.runId,
    ]);
    const toResume = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    await pool.query(`UPDATE runs SET status = 'resumed' WHERE run_id = $1`, [toResume.runId]);

    const toComplete = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    const completed = await completeRun({ connectionString: connectionString! }, toComplete.runId);

    const toFail = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    const failed = await failRun({ connectionString: connectionString! }, toFail.runId, "boom");

    const toCancel = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    const cancelled = await cancelRun({ connectionString: connectionString! }, toCancel.runId);

    const open = await listOpenRuns({ connectionString: connectionString! }, { taskId });
    const openIds = open.map((r) => r.runId);

    expect(openIds).toContain(started.runId);
    expect(openIds).toContain(resumed.runId);
    expect(openIds).toContain(toResume.runId);
    // MUTATION-PROOF (AC2): removing the status filter from listOpenRuns'
    // WHERE clause would make these three assertions fail by including a
    // terminal run.
    expect(openIds).not.toContain(completed.runId);
    expect(openIds).not.toContain(failed.runId);
    expect(openIds).not.toContain(cancelled.runId);
    expect(open.every((r) => openRunStatuses.includes(r.status))).toBe(true);
  });

  it("scopes by taskId and rejects an invalid one", async () => {
    const unrelated = await listOpenRuns(
      { connectionString: connectionString! },
      { taskId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(unrelated).toHaveLength(0);
  });
});

// TASK-136: parkRun is the accessor a real RunParkPort implementation calls
// to transition a chat run to waiting_approval when a tool-use hits a
// pending approval — previously the only way a row ever reached this status
// was a test forging it directly with SQL (see the `listOpenRuns` fixture
// above and TASK-135's dossier finding).
integration("packages/db runs — parkRun (TASK-136)", () => {
  let pool: Pool;
  const roleId = "task-136-parkrun-suite";
  let taskId: string;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`,
      [roleId],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...integrationPoolConfig });
    await cleanup();
    const task = await createTask(
      integrationOptions,
      { roleId, title: "parkRun fixture", goal: "g", requestedBy: "alister" },
    );
    taskId = task.taskId;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("transitions a started run to waiting_approval", async () => {
    const run = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    expect(run.status).toBe("started");

    const parked = await parkRun({ connectionString: connectionString! }, run.runId);
    expect(parked.runId).toBe(run.runId);
    expect(parked.status).toBe("waiting_approval");
    // MUTATION-PROOF: parkRun must not touch ended_at/session_ref/etc — it
    // is not a terminal transition, unlike completeRun/failRun/cancelRun.
    expect(parked.endedAt).toBeNull();
  });

  it("transitions a resumed run to waiting_approval too (idempotent kill/resume/park cycles)", async () => {
    const run = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    await pool.query(`UPDATE runs SET status = 'resumed' WHERE run_id = $1`, [run.runId]);

    const parked = await parkRun({ connectionString: connectionString! }, run.runId);
    expect(parked.status).toBe("waiting_approval");
  });

  it("throws IllegalRunTransitionError parking an already-parked run (no silent double-park)", async () => {
    const run = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    await parkRun({ connectionString: connectionString! }, run.runId);

    await expect(
      parkRun({ connectionString: connectionString! }, run.runId),
    ).rejects.toThrow(IllegalRunTransitionError);
    await expect(
      parkRun({ connectionString: connectionString! }, run.runId),
    ).rejects.toMatchObject({ runId: run.runId, fromStatus: "waiting_approval" });
  });

  it("throws IllegalRunTransitionError parking a terminal run", async () => {
    const run = await startRun({ connectionString: connectionString! }, { taskId, provider: "claude" });
    const completed = await completeRun({ connectionString: connectionString! }, run.runId);
    expect(completed.status).toBe("completed");

    await expect(
      parkRun({ connectionString: connectionString! }, run.runId),
    ).rejects.toThrow(IllegalRunTransitionError);
  });

  it("throws RunNotFoundError parking an unknown run", async () => {
    await expect(
      parkRun({ connectionString: connectionString! }, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/was not found/);
  });
});

// TASK-269: getLatestRunForThread is the query the control-api's chat send
// path uses to find the run it should continue from. Real Postgres, real
// `tasks.execution` JSON (via `createTaskExecutionRun`, the same production
// path `submitTaskExecution` calls) -- not a hand-built fixture that might
// not match the real column shape.
integration("packages/db runs — getLatestRunForThread (TASK-269)", () => {
  let pool: Pool;
  const roleId = "task-269-latestrun-role-a";
  const otherRoleId = "task-269-latestrun-role-b";
  const threadId = "22222222-2222-2222-2222-222222222222";
  const otherThreadId = "33333333-3333-3333-3333-333333333333";

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = ANY($1))`,
      [[roleId, otherRoleId]],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = ANY($1)`, [[roleId, otherRoleId]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...integrationPoolConfig });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("returns null for a thread with no prior run (first message ever)", async () => {
    const result = await getLatestRunForThread(integrationOptions, { threadId, epoch: 0 });
    expect(result).toBeNull();
  });

  it("finds the newest run for a thread via tasks.execution, ignoring runs on unrelated threads", async () => {
    const older = await createTaskExecutionRun(integrationOptions, {
      task: { roleId, title: "turn 1", goal: "hi", requestedBy: "chat:thread:" + threadId },
      execution: { version: 1, kind: "chat", threadId, epoch: 0 } as StampedExecution,
      provider: "claude",
    });
    // A real gap between started_at values, same technique as this file's
    // other suites, so "newest" is unambiguous without forcing a tie.
    await pool.query(`UPDATE runs SET started_at = started_at - interval '1 minute' WHERE run_id = $1`, [
      older.runId,
    ]);
    const newer = await createTaskExecutionRun(integrationOptions, {
      task: { roleId, title: "turn 2", goal: "hi again", requestedBy: "chat:thread:" + threadId },
      execution: { version: 1, kind: "chat", threadId, epoch: 0 } as StampedExecution,
      provider: "claude",
    });
    const unrelated = await createTaskExecutionRun(integrationOptions, {
      task: { roleId, title: "other thread", goal: "hi", requestedBy: "chat:thread:" + otherThreadId },
      execution: { version: 1, kind: "chat", threadId: otherThreadId, epoch: 0 } as StampedExecution,
      provider: "claude",
    });

    const result = await getLatestRunForThread(integrationOptions, { threadId, epoch: 0 });
    expect(result?.runId).toBe(newer.runId);
    expect(result?.runId).not.toBe(older.runId);
    expect(result?.runId).not.toBe(unrelated.runId);
  });

  it("scopes by roleId so a group/fan-out thread never hands one recipient's session to another's turn", async () => {
    const groupThreadId = "44444444-4444-4444-4444-444444444444";
    const forRoleA = await createTaskExecutionRun(integrationOptions, {
      task: { roleId, title: "fanout a", goal: "hi", requestedBy: "chat:thread:" + groupThreadId },
      execution: {
        version: 1,
        kind: "fanout",
        threadId: groupThreadId,
        sourceMessageId: "55555555-5555-5555-5555-555555555555",
        recipientRoleId: roleId,
        epoch: 0,
      } as StampedExecution,
      provider: "claude",
    });
    await pool.query(`UPDATE runs SET started_at = started_at - interval '1 minute' WHERE run_id = $1`, [
      forRoleA.runId,
    ]);
    const forRoleB = await createTaskExecutionRun(integrationOptions, {
      task: { roleId: otherRoleId, title: "fanout b", goal: "hi", requestedBy: "chat:thread:" + groupThreadId },
      execution: {
        version: 1,
        kind: "fanout",
        threadId: groupThreadId,
        sourceMessageId: "55555555-5555-5555-5555-555555555555",
        recipientRoleId: otherRoleId,
        epoch: 0,
      } as StampedExecution,
      provider: "claude",
    });

    const forA = await getLatestRunForThread(integrationOptions, { threadId: groupThreadId, roleId, epoch: 0 });
    expect(forA?.runId).toBe(forRoleA.runId);
    const forB = await getLatestRunForThread(integrationOptions, {
      threadId: groupThreadId,
      roleId: otherRoleId,
      epoch: 0,
    });
    expect(forB?.runId).toBe(forRoleB.runId);
    // MUTATION-PROOF: without the role_id filter, both queries above would
    // return whichever run is newest overall (forRoleB), silently handing
    // role A's turn role B's Claude session.
    expect(forA?.runId).not.toBe(forB?.runId);
  });

  it("TASK-270 rework: a run from a stale epoch is never eligible once /fresh bumps the thread forward", async () => {
    // `thread_context` FKs to a real `threads` row (unlike this suite's
    // other cases, which never touch `threads`/`roles` at all -- `runs`'s
    // own FKs don't require it). `threads.role_id` is additionally
    // UNIQUE-constrained to `roles`, so this test seeds its own
    // self-contained role+thread pair rather than reusing the describe
    // block's fixture role ids.
    const freshRoleId = "task-270-freshepoch-role";
    await pool.query(
      `INSERT INTO roles (role_id, tenant_id, name, title, description, provider)
       VALUES ($1, 'basileia', $1, 'TASK-270 fixture', 'TASK-270 fixture', 'claude')
       ON CONFLICT (role_id) DO NOTHING`,
      [freshRoleId],
    );
    const threadResult = await pool.query<{ id: string }>(
      "INSERT INTO threads (role_id) VALUES ($1) RETURNING id",
      [freshRoleId],
    );
    const freshThreadId = threadResult.rows[0]!.id;

    try {
      // getThreadEpoch (TASK-270 rework): a brand-new thread with no
      // `thread_context` row yet must read as epoch 0 -- the same default
      // `getOrInitThreadContext` would lazily materialize -- WITHOUT this
      // read-only helper creating that row itself (see runs.ts's doc
      // comment for why `submitTaskExecution` deliberately avoids the
      // heavier upsert on every ordinary chat turn).
      expect(await getThreadEpoch(integrationOptions, freshThreadId)).toBe(0);

      // Epoch 0: an ordinary completed turn, exactly like production's
      // `submitTaskExecution` would stamp it.
      const beforeFresh = await createTaskExecutionRun(integrationOptions, {
        task: { roleId: freshRoleId, title: "before fresh", goal: "hi", requestedBy: "chat:thread:" + freshThreadId },
        execution: { version: 1, kind: "chat", threadId: freshThreadId, epoch: 0 } as StampedExecution,
        provider: "claude",
      });
      await completeRun(integrationOptions, beforeFresh.runId);

      // Still epoch 0: the un-bumped thread must still find it.
      const stillEpochZero = await getLatestRunForThread(integrationOptions, {
        threadId: freshThreadId,
        roleId: freshRoleId,
        epoch: 0,
      });
      expect(stillEpochZero?.runId).toBe(beforeFresh.runId);

      // `/fresh` bumps the epoch (this is the exact primitive
      // `POST /threads/:id/fresh` calls) -- the pre-fresh run must now be
      // invisible to a lookup scoped to the NEW current epoch, even though
      // it is still (and will always be) the newest row in the table.
      const context = await startFreshEpoch(integrationOptions, freshThreadId);
      expect(context.epoch).toBe(1);
      // getThreadEpoch must agree with startFreshEpoch's own return value --
      // the two ways `submitTaskExecution`/`/fresh` observe "current epoch"
      // must never disagree.
      expect(await getThreadEpoch(integrationOptions, freshThreadId)).toBe(1);

      const afterFresh = await getLatestRunForThread(integrationOptions, {
        threadId: freshThreadId,
        roleId: freshRoleId,
        epoch: context.epoch,
      });
      expect(afterFresh).toBeNull();

      // A NEW run stamped with the new epoch is found normally.
      const postFreshRun = await createTaskExecutionRun(integrationOptions, {
        task: { roleId: freshRoleId, title: "after fresh", goal: "hi", requestedBy: "chat:thread:" + freshThreadId },
        execution: { version: 1, kind: "chat", threadId: freshThreadId, epoch: context.epoch } as StampedExecution,
        provider: "claude",
      });
      const foundPostFresh = await getLatestRunForThread(integrationOptions, {
        threadId: freshThreadId,
        roleId: freshRoleId,
        epoch: context.epoch,
      });
      expect(foundPostFresh?.runId).toBe(postFreshRun.runId);
    } finally {
      await pool.query(`DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`, [freshRoleId]);
      await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [freshRoleId]);
      await pool.query(`DELETE FROM thread_context WHERE thread_id = $1`, [freshThreadId]);
      await pool.query(`DELETE FROM threads WHERE id = $1`, [freshThreadId]);
      await pool.query(`DELETE FROM roles WHERE role_id = $1`, [freshRoleId]);
    }
  });
});

// TASK-269: `resumeRun` is the existing, already-tested machinery this
// task's ports.ts wiring reuses to seed a brand-new run's `session_ref`
// with a prior completed run's session (continuity) and, separately,
// chatRunDriver.ts reuses it to record the REAL session id the Claude CLI
// itself reports once a turn completes. Prove both call shapes work exactly
// the way those call sites depend on: overwriting an existing session_ref
// (not just filling a null one), and remaining legal on a run whose status
// is already 'started' (never previously resumed).
integration("packages/db runs — resumeRun as a session_ref setter (TASK-269 reuse)", () => {
  let pool: Pool;
  const roleId = "task-269-resumeasfset-role";
  let taskId: string;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`,
      [roleId],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...integrationPoolConfig });
    await cleanup();
    const task = await createTask(integrationOptions, { roleId, title: "fixture", goal: "g", requestedBy: "alister" });
    taskId = task.taskId;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("seeds a session_ref on a freshly-started run (continuity) and moves it to 'resumed'", async () => {
    const run = await startRun(integrationOptions, { taskId, provider: "claude" });
    expect(run.sessionRef).toBeNull();

    const seeded = await resumeRun(integrationOptions, run.runId, "prior-turn-session-id");
    expect(seeded.status).toBe("resumed");
    expect(seeded.sessionRef).toBe("prior-turn-session-id");
  });

  it("overwrites an already-seeded session_ref with the CLI's real one after execution", async () => {
    const run = await startRun(integrationOptions, { taskId, provider: "claude" });
    await resumeRun(integrationOptions, run.runId, "seeded-placeholder");

    const recorded = await resumeRun(integrationOptions, run.runId, "real-cli-session-id");
    expect(recorded.sessionRef).toBe("real-cli-session-id");

    const reread = await getRun(integrationOptions, run.runId);
    expect(reread?.sessionRef).toBe("real-cli-session-id");
  });
});

// NOT gated behind `integration` (review round 3): same reasoning as
// tasks.test.ts's sibling pin — this reads the compiled SQL string off disk
// and needs no database, so it must run unconditionally. The CI `pnpm test`
// job carries no DATABASE_URL (only `canaries` has a Postgres service); left
// inside the gated describe above, this pin would silently no-op there.
describe("listRuns ORDER BY — deterministic source-level tiebreak pin (review round 2)", () => {
  it("MUTATION-PROVEN: the ORDER BY clause contains run_id DESC after started_at DESC", () => {
    // Same rationale as tasks.test.ts's sibling assertion: the
    // behavioural tie test above only catches a deleted tiebreaker
    // probabilistically (measured on the identical tasks.ts pattern:
    // 14/17 runs, ~82%), since Postgres does not order equal sort keys
    // deterministically. This reads the compiled SQL string directly
    // for a 100%-deterministic complement.
    const src = readFileSync(new URL("./runs.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ORDER BY started_at DESC, run_id DESC/);
  });
});
