import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig } from "./database.js";
import { getPlatformSpendUsd, getProviderSpendUsd, getRoutineSpendUsd, recordSpend, startOfCurrentMonthUtc } from "./spend.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db spend — recordSpend / getRoutineSpendUsd / getPlatformSpendUsd (TASK-143)", () => {
  let pool: Pool;
  const routineIdA = "task-143-routine-a";
  const routineIdB = "task-143-routine-b";
  const runId = "task-143-run-1";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM spend_records WHERE run_id LIKE 'task-143-run-%'`);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("persists a real spend record against real Postgres", async () => {
    const record = await recordSpend(
      { connectionString: connectionString! },
      {
        runId,
        routineId: routineIdA,
        provider: "codex",
        model: "gpt-5.4",
        costUsd: 1.25,
        tokens: 1000,
      },
    );
    expect(record.spendId).toBeTruthy();
    expect(record.routineId).toBe(routineIdA);
    expect(record.costUsd).toBeCloseTo(1.25);
    expect(record.tokens).toBe(1000);
  });

  it("sums a routine's accumulated spend live, isolated from other routines", async () => {
    await recordSpend(
      { connectionString: connectionString! },
      { runId, routineId: routineIdA, provider: "codex", model: "gpt-5.4", costUsd: 2.5 },
    );
    await recordSpend(
      { connectionString: connectionString! },
      { runId, routineId: routineIdB, provider: "grok", model: "grok-5", costUsd: 100 },
    );

    const spendA = await getRoutineSpendUsd({ connectionString: connectionString! }, routineIdA);
    const spendB = await getRoutineSpendUsd({ connectionString: connectionString! }, routineIdB);

    // 1.25 (previous test) + 2.5 in this test
    expect(spendA).toBeCloseTo(3.75);
    expect(spendB).toBeCloseTo(100);
  });

  it("returns 0 for a routine with no spend records", async () => {
    const spend = await getRoutineSpendUsd({ connectionString: connectionString! }, "task-143-no-such-routine");
    expect(spend).toBe(0);
  });

  it("sums platform-wide spend since a given instant, excluding older rows", async () => {
    const before = await getPlatformSpendUsd({ connectionString: connectionString! }, startOfCurrentMonthUtc());
    await recordSpend(
      { connectionString: connectionString! },
      { runId, routineId: null, provider: "codex", model: "gpt-5.4", costUsd: 10 },
    );
    const after = await getPlatformSpendUsd({ connectionString: connectionString! }, startOfCurrentMonthUtc());
    expect(after).toBeCloseTo(before + 10);

    const future = new Date(Date.now() + 60_000);
    const nothingYet = await getPlatformSpendUsd({ connectionString: connectionString! }, future);
    expect(nothingYet).toBe(0);
  });

  // TASK-209 — the live figure behind ADR-011 §7's per-provider hard cap.
  it("sums one provider's own spend, excluding other providers and older rows", async () => {
    const db = { connectionString: connectionString! };
    const since = startOfCurrentMonthUtc();
    const geminiBefore = await getProviderSpendUsd(db, "gemini", since);
    const platformBefore = await getPlatformSpendUsd(db, since);

    await recordSpend(db, { runId, routineId: null, provider: "gemini", model: "gemini-3.7-flash", costUsd: 7 });
    await recordSpend(db, { runId, routineId: null, provider: "claude", model: "claude-haiku-4-5", costUsd: 11 });

    // The provider figure moves by its own spend only...
    expect(await getProviderSpendUsd(db, "gemini", since)).toBeCloseTo(geminiBefore + 7);
    // ...while the platform figure moves by both. A cap compared against a
    // total that included other providers would deny the wrong runs.
    expect(await getPlatformSpendUsd(db, since)).toBeCloseTo(platformBefore + 18);

    const future = new Date(Date.now() + 60_000);
    expect(await getProviderSpendUsd(db, "gemini", future)).toBe(0);
    expect(await getProviderSpendUsd(db, "no-such-provider", since)).toBe(0);
  });

  it("refuses an empty provider rather than silently summing every provider", async () => {
    await expect(getProviderSpendUsd({ connectionString: connectionString! }, "  ")).rejects.toThrow(/provider/);
  });
});
