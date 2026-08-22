import { readFileSync } from "node:fs";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTask, defaultPoolConfig, getTask, listTasks } from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db tasks — read + CRUD (TASK-061 / OIK-084)", () => {
  let pool: Pool;
  const roleId = "task-061-tasks-suite";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("creates a task against the live schema and reads it back byte-identical", async () => {
    const created = await createTask(
      { connectionString: connectionString! },
      {
        roleId,
        title: "Triage inbox",
        goal: "Draft replies to unread mail",
        requestedBy: "alister",
      },
    );

    expect(created.status).toBe("draft");
    expect(created.tenantId).toBe("basileia");
    expect(created.routineId).toBeNull();

    const fetched = await getTask({ connectionString: connectionString! }, created.taskId);
    expect(fetched).toEqual(created);
  });

  it("getTask returns null for an unknown taskId", async () => {
    const result = await getTask(
      { connectionString: connectionString! },
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });

  it("listTasks paginates newest-first, breaks a created_at tie via task_id DESC, and the cursor never repeats or skips a row", async () => {
    await cleanup();
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(
        await createTask(
          { connectionString: connectionString! },
          { roleId, title: `task-${i}`, goal: "g", requestedBy: "alister" },
        ),
      );
    }

    // Force TWO independent, REAL created_at ties, each straddling a page
    // boundary (limit=2 below: pages are [4,3][2,1][0]). Left to
    // `createTask`'s `now()` default, every fixture row gets a distinct
    // timestamp, so a prior version of this test never actually exercised
    // the `task_id DESC` tiebreaker in `ORDER BY created_at DESC, task_id
    // DESC` — a silently dropped tiebreaker still passed this test (review
    // round 1 finding). Pin the tiebreak direction explicitly rather than
    // just asserting "no dup/skip", since task_id is a random UUID
    // uncorrelated with insertion/physical order: a wrong or missing
    // tiebreaker has no principled reason to reproduce this exact
    // ordering. Postgres does not guarantee any particular order among
    // *equal* sort keys absent a full tiebreak column, so a single tie's
    // catch rate against that mutation is empirically well under 100%
    // (verified locally: ~70/30 over repeated runs) — two independent ties
    // compound the odds of the mutation being caught, but ORCH's own
    // measurement over 17 runs came back 14 RED / 3 GREEN — a real but
    // NOT total ~82% catch rate, not "close to certainty" as an earlier
    // draft of this comment claimed. That is why the source-level check
    // below exists: it is the 100%-deterministic half of this coverage,
    // and this behavioural test is kept alongside it because it is the
    // only one of the two that actually exercises `listTasks`'s runtime
    // pagination, not merely its SQL text.
    //
    // Each UPDATE copies `created_at` server-side (never round-tripping
    // through the JS driver's Date, which is millisecond-precision and
    // would silently de-tie a `timestamptz`'s microsecond precision) so
    // the paired rows are byte-identical in Postgres, not just close.
    await pool.query(
      `UPDATE tasks SET created_at = (SELECT created_at FROM tasks WHERE task_id = $1)
       WHERE task_id = $2`,
      [created[2]!.taskId, created[3]!.taskId],
    );
    const [tieALoser, tieAWinner] = [created[2]!.taskId, created[3]!.taskId].sort();
    await pool.query(
      `UPDATE tasks SET created_at = (SELECT created_at FROM tasks WHERE task_id = $1)
       WHERE task_id = $2`,
      [created[0]!.taskId, created[1]!.taskId],
    );
    const [tieBLoser, tieBWinner] = [created[0]!.taskId, created[1]!.taskId].sort();

    const firstPage = await listTasks(
      { connectionString: connectionString! },
      { tenantId: "basileia", status: "draft", limit: 2 },
    );
    expect(firstPage.tasks).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    // Newest-first: the most recently created (untouched) row leads.
    expect(firstPage.tasks[0]?.taskId).toBe(created[4]?.taskId);
    // Tie A broken by task_id DESC: the lexicographically larger of the
    // two tied task_ids (== Postgres uuid-binary DESC order) is second.
    expect(firstPage.tasks[1]?.taskId).toBe(tieAWinner);

    const seen = new Set(firstPage.tasks.map((t) => t.taskId));
    let cursor = firstPage.nextCursor;
    let guard = 0;
    let pageIndex = 0;
    while (cursor !== null && guard < 10) {
      const page = await listTasks(
        { connectionString: connectionString! },
        { tenantId: "basileia", status: "draft", limit: 2, cursor },
      );
      if (pageIndex === 0) {
        // Page 2 must lead with tie A's loser and trail with tie B's
        // winner: the ORDER BY tiebreaker and the keyset WHERE clause's
        // tuple comparison must agree on direction, or a row is silently
        // skipped (or its tie partner silently repeated) right here.
        expect(page.tasks[0]?.taskId).toBe(tieALoser);
        expect(page.tasks[1]?.taskId).toBe(tieBWinner);
      }
      if (pageIndex === 1) {
        expect(page.tasks[0]?.taskId).toBe(tieBLoser);
      }
      for (const task of page.tasks) {
        expect(seen.has(task.taskId)).toBe(false);
        seen.add(task.taskId);
      }
      cursor = page.nextCursor;
      guard += 1;
      pageIndex += 1;
    }

    for (const task of created) {
      expect(seen.has(task.taskId)).toBe(true);
    }
  });

});

// NOT gated behind `integration` (review round 3): this reads the compiled
// SQL string directly off disk and asserts nothing about a live database, so
// it must run unconditionally — the CI `pnpm test` job carries no
// DATABASE_URL (only `canaries` has a Postgres service), and a pin left
// inside the DATABASE_URL-gated describe above would silently no-op there,
// meaning the tiebreaker could be deleted without the default pipeline ever
// noticing.
describe("listTasks ORDER BY — deterministic source-level tiebreak pin (review round 2)", () => {
  it("MUTATION-PROVEN: the ORDER BY clause contains task_id DESC after created_at DESC", () => {
    // The behavioural test above only catches a deleted tiebreaker
    // ~82% of the time (measured: 14/17 runs), because Postgres does
    // not guarantee any particular order among equal sort keys. This
    // source-level assertion is the 100%-deterministic complement: it
    // reads the compiled SQL string directly, so there is no run-to-run
    // variance to escape through.
    const src = readFileSync(new URL("./tasks.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ORDER BY created_at DESC, task_id DESC/);
  });
});
