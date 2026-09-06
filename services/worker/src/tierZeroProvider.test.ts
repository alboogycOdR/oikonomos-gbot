import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPlatformSpendUsd: vi.fn<() => Promise<number>>(),
  getRoutine: vi.fn(),
  getRoutineSpendUsd: vi.fn<() => Promise<number>>(),
  recordSpend: vi.fn<() => Promise<void>>(),
}));

vi.mock("@oikonomos/db", () => dbMocks);

import { createTierZeroProvider } from "./tierZeroProvider.js";

describe("createTierZeroProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function configureBudget(options?: {
    routineSpendUsd?: number;
    routineBudgetUsd?: number | null;
    platformSpendUsd?: number;
  }): void {
    dbMocks.getRoutineSpendUsd.mockResolvedValue(options?.routineSpendUsd ?? 0);
    dbMocks.getRoutine.mockResolvedValue({ definition: { budgetUsd: options?.routineBudgetUsd ?? 1 } });
    dbMocks.getPlatformSpendUsd.mockResolvedValue(options?.platformSpendUsd ?? 0);
    dbMocks.recordSpend.mockResolvedValue(undefined);
  }

  it("records every completed call through the generic budget sink", async () => {
    configureBudget();
    const complete = createTierZeroProvider({
      db: { connectionString: "postgres://test/db" },
      runId: "task-196-recorded-turn",
      routineId: "routine-1",
      endpoint: "http://router/v1/chat/completions",
      model: "cheap",
      fetch: async () => new Response(JSON.stringify({
        choices: [{ message: { content: "summary" } }],
        usage: { cost_usd: 0.25 },
      }), { status: 200 }),
    });

    await expect(complete("summarise this")).resolves.toBe("summary");
    expect(dbMocks.recordSpend).toHaveBeenCalledWith(
      { connectionString: "postgres://test/db" },
      expect.objectContaining({
        runId: "task-196-recorded-turn",
        routineId: "routine-1",
        provider: "free-llm-api",
        model: "cheap",
        costUsd: 0.25,
        tokens: null,
      }),
    );
  });

  it("denies before calling FreeLLMAPI when the routine budget is exhausted", async () => {
    configureBudget({ routineSpendUsd: 1, routineBudgetUsd: 1 });
    const fetch = vi.fn();
    const complete = createTierZeroProvider({
      db: { connectionString: "postgres://test/db" },
      runId: "task-196-denied-turn",
      routineId: "routine-1",
      endpoint: "http://router/v1/chat/completions",
      model: "cheap",
      fetch,
    });

    await expect(complete("do not call")).rejects.toThrow("budget.routine_exceeded");
    expect(fetch).not.toHaveBeenCalled();
    expect(dbMocks.recordSpend).not.toHaveBeenCalled();
  });

  it("fails closed before calling FreeLLMAPI when the budget read cannot run", async () => {
    dbMocks.getPlatformSpendUsd.mockRejectedValue(new Error("database unavailable"));
    const fetch = vi.fn();
    const complete = createTierZeroProvider({
      db: { connectionString: "postgres://test/db" },
      runId: "task-196-budget-read-failure",
      endpoint: "http://router/v1/chat/completions",
      model: "cheap",
      fetch,
    });
    await expect(complete("score this")).rejects.toThrow(/^budget\.check_failed:/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed budget configuration before it can make a call", () => {
    expect(() => createTierZeroProvider({
      db: { connectionString: "postgres://example/db" },
      runId: "task-196-invalid-budget",
      endpoint: "http://router/v1/chat/completions",
      model: "cheap",
      usdToZarRate: 0,
    })).toThrow(/usdToZarRate/);
  });
});
