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

  // ADR-011 makes Gemini the adopted provider; Tier-0 is text-only, so this
  // routing sits inside §3's Stage-1 boundary (observation, no tool
  // execution) and does not touch what §7's addendum gates.
  it("prefers Gemini when GEMINI_API_KEY is set, and prices its turns", async () => {
    const { resolveTierZeroEnvConfig, GEMINI_OPENAI_COMPATIBLE_ENDPOINT } = await import("./tierZeroProvider.js");

    const config = resolveTierZeroEnvConfig({ GEMINI_API_KEY: "test-key" } as NodeJS.ProcessEnv);

    expect(config?.endpoint).toBe(GEMINI_OPENAI_COMPATIBLE_ENDPOINT);
    expect(config?.model).toBe("gemini-3.7-flash");
    expect(config?.providerId).toBe("gemini");
    // Without this the endpoint's missing cost field records every turn as $0.
    expect(config?.costFromUsage).toBeTypeOf("function");
    expect(config?.costFromUsage?.({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.75, 6);
  });

  it("falls back to the FreeLLMAPI router when no Gemini key is configured", async () => {
    const { resolveTierZeroEnvConfig } = await import("./tierZeroProvider.js");

    const config = resolveTierZeroEnvConfig({
      FREE_LLM_API_ENDPOINT: "http://router/v1/chat/completions",
      FREE_LLM_API_MODEL: "cheap",
    } as NodeJS.ProcessEnv);

    expect(config?.endpoint).toBe("http://router/v1/chat/completions");
    expect(config?.providerId).toBeUndefined();
    expect(resolveTierZeroEnvConfig({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("attributes Gemini-backed spend to gemini, not to the FreeLLMAPI transport", async () => {
    configureBudget();
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      // Google's OpenAI-compatible surface reports tokens and no cost.
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const complete = createTierZeroProvider({
      db: { connectionString: "postgres://example/db" },
      runId: "tier-zero-gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: "gemini-3.7-flash",
      providerId: "gemini",
      costFromUsage: ({ inputTokens, outputTokens }) => (inputTokens / 1_000_000) * 0.75 + (outputTokens / 1_000_000) * 3.75,
      fetch: fetch as never,
    });

    await complete("summarise this");

    expect(dbMocks.recordSpend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "gemini", costUsd: expect.closeTo(0.75, 6) }),
    );
  });

  // Real shape measured live against gemini-3.7-flash on 2026-09-07:
  // {prompt_tokens: 9, completion_tokens: 4, total_tokens: 130}. The 117
  // unaccounted tokens are thinking tokens, which Google bills at the OUTPUT
  // rate. Pricing on completion_tokens alone under-counts this turn ~30x.
  it("bills a reasoning model's thinking tokens, not just its visible reply", async () => {
    configureBudget();
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "TIER0 OK" } }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 130 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const complete = createTierZeroProvider({
      db: { connectionString: "postgres://example/db" },
      runId: "tier-zero-thinking",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: "gemini-3.7-flash",
      providerId: "gemini",
      costFromUsage: ({ inputTokens, outputTokens }) => (inputTokens / 1_000_000) * 0.75 + (outputTokens / 1_000_000) * 3.75,
      fetch: fetch as never,
    });

    await complete("summarise this");

    // 9 input @ $0.75/M + (130 - 9) = 121 billable output @ $3.75/M.
    const expected = (9 / 1_000_000) * 0.75 + (121 / 1_000_000) * 3.75;
    expect(dbMocks.recordSpend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ costUsd: expect.closeTo(expected, 12) }),
    );
    // The naive reading would have been ~30x cheaper than reality.
    const naive = (9 / 1_000_000) * 0.75 + (4 / 1_000_000) * 3.75;
    expect(expected).toBeGreaterThan(naive * 10);
  });

  // The production caller (chatRunDriver's resolveTierZeroProviderOptions)
  // passes only endpoint/model/apiKey, so this default IS the live ceiling
  // for every context-compaction and group-routing call. It was a second,
  // duplicated literal that went stale at the pre-2026-09-06 R30,000 figure,
  // gating real Tier-0 spend at ~86x the actual R350 platform ceiling.
  it("gates Tier-0 spend against the one canonical platform ceiling, not a stale copy", async () => {
    const { DEFAULT_PLATFORM_CEILING_ZAR } = await import("./tierZeroProvider.js");
    const { DEFAULT_PLATFORM_CEILING_ZAR: canonical } = await import("./subprocessProviders.js");

    expect(DEFAULT_PLATFORM_CEILING_ZAR).toBe(canonical);
    expect(DEFAULT_PLATFORM_CEILING_ZAR).toBe(350);
  });

  it("denies a Tier-0 call once platform spend passes the real R350 ceiling", async () => {
    // Just over R350 at the default 18.5 rate: ~US$18.92.
    configureBudget({ platformSpendUsd: 19 });
    const fetch = vi.fn();
    const complete = createTierZeroProvider({
      db: { connectionString: "postgres://example/db" },
      runId: "tier-zero-ceiling",
      endpoint: "http://router/v1/chat/completions",
      model: "cheap",
      fetch: fetch as never,
    });

    await expect(complete("summarise this")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
