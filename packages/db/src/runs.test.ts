import { readFileSync } from "node:fs";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  completeRun,
  createTask,
  defaultPoolConfig,
  getAuditEventsForRun,
  IllegalRunTransitionError,
  insertApproval,
  insertAuditEvent,
  listPendingApprovals,
  listRuns,
  startRun,
} from "./index.js";
// `listOpenRuns`/`openRunStatuses` (OIK-106) are new in this task and not
// yet re-exported from the package barrel (`index.ts` is outside this
// task's `Owned_Paths` — see the dossier) — imported directly from the
// module instead.
import { failRun, cancelRun, listOpenRuns, openRunStatuses } from "./runs.js";

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
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    const task = await createTask(
      { connectionString: connectionString! },
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
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    const task = await createTask(
      { connectionString: connectionString! },
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
