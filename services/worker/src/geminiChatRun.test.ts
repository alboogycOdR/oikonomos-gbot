import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  // Typed to the real arity: the `since` argument is what these tests assert
  // on, so a zero-arg mock type would hide the very thing being checked.
  getPlatformSpendUsd: vi.fn<(options: unknown, since?: Date) => Promise<number>>(),
  getProviderSpendUsd: vi.fn<(options: unknown, provider: string, since?: Date) => Promise<number>>(),
  getRoutineSpendUsd: vi.fn<(options: unknown, routineId: string) => Promise<number>>(),
  startOfCurrentMonthUtc: vi.fn(() => new Date("2026-09-01T00:00:00Z")),
}));

vi.mock("@oikonomos/db", () => dbMocks);

import {
  GEMINI_CAP_MISSING_REASON,
  GEMINI_PROVIDER_ID,
  geminiTurnCostUsd,
  resolveGeminiBudget,
} from "./geminiChatRun.js";

const db = { connectionString: "postgres://example/db" };
const base = { db, routineId: null, routineBudgetUsd: null, platformCeilingUsd: 18.92 };

describe("resolveGeminiBudget — ADR-011 §7's gate on tool-executing Gemini (TASK-215)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getPlatformSpendUsd.mockResolvedValue(0);
    dbMocks.getProviderSpendUsd.mockResolvedValue(0);
    dbMocks.getRoutineSpendUsd.mockResolvedValue(0);
    dbMocks.startOfCurrentMonthUtc.mockReturnValue(new Date("2026-09-01T00:00:00Z"));
  });

  it("DENIES when no provider cap is configured, instead of falling through to the platform ceiling", async () => {
    // The whole of ADR-011 §7. Unset-means-uncapped is right for the pure
    // gate; on THIS path it is the exact thing the amendment forbids.
    const decision = await resolveGeminiBudget({ ...base, resolveCap: () => null });

    expect(decision).toEqual({ decision: "deny", reason: GEMINI_CAP_MISSING_REASON });
    // Denied before any spend is even read — nothing to weigh, the answer is
    // structural.
    expect(dbMocks.getPlatformSpendUsd).not.toHaveBeenCalled();
  });

  it("allows a capped provider with headroom", async () => {
    await expect(resolveGeminiBudget({ ...base, resolveCap: () => 5 })).resolves.toEqual({ decision: "allow" });
  });

  it("denies once the provider's own spend reaches its cap, with the platform still in headroom", async () => {
    dbMocks.getProviderSpendUsd.mockResolvedValue(5);
    dbMocks.getPlatformSpendUsd.mockResolvedValue(0.01);

    await expect(resolveGeminiBudget({ ...base, resolveCap: () => 5 }))
      .resolves.toEqual({ decision: "deny", reason: "budget.provider_exceeded" });
  });

  it("measures provider and platform spend over ONE instant, not two", async () => {
    // Two independent defaults resolve at two times; a cap compared against a
    // differently-scoped total is a coincidence, not a cap.
    await resolveGeminiBudget({ ...base, resolveCap: () => 5 });

    const platformSince = dbMocks.getPlatformSpendUsd.mock.calls[0]?.[1];
    const providerSince = dbMocks.getProviderSpendUsd.mock.calls[0]?.[2];
    expect(platformSince).toBeInstanceOf(Date);
    expect(providerSince).toEqual(platformSince);
    // And the caller may pin it explicitly.
    vi.clearAllMocks();
    dbMocks.getPlatformSpendUsd.mockResolvedValue(0);
    dbMocks.getProviderSpendUsd.mockResolvedValue(0);
    const pinned = new Date("2026-09-05T00:00:00Z");
    await resolveGeminiBudget({ ...base, resolveCap: () => 5, since: pinned });
    expect(dbMocks.getPlatformSpendUsd.mock.calls[0]?.[1]).toEqual(pinned);
    expect(dbMocks.getProviderSpendUsd.mock.calls[0]?.[2]).toEqual(pinned);
  });

  it("converts a malformed cap into a deny rather than letting it escape", async () => {
    const decision = await resolveGeminiBudget({
      ...base,
      resolveCap: () => { throw new Error("OIK_PROVIDER_CAP_USD_GEMINI must be a finite number >= 0."); },
    });

    expect(decision.decision).toBe("deny");
    expect(decision).toMatchObject({ reason: expect.stringContaining("budget.check_failed") });
  });

  it("fails closed when a spend read cannot run", async () => {
    dbMocks.getProviderSpendUsd.mockRejectedValue(new Error("connection refused"));

    const decision = await resolveGeminiBudget({ ...base, resolveCap: () => 5 });
    expect(decision.decision).toBe("deny");
  });

  it("caps against the same provider label spend is recorded under", () => {
    // A cap keyed on a name nothing writes is silently inert.
    expect(GEMINI_PROVIDER_ID).toBe("gemini");
  });
});

describe("geminiTurnCostUsd — thinking tokens are billed output (TASK-215)", () => {
  it("bills the tokens Gemini does not report as candidates", () => {
    // Real shape measured live 2026-09-07: 9 prompt, 4 candidate, 130 total.
    // The 117 unreported tokens are thinking tokens, billed at OUTPUT rate.
    const before2027 = new Date("2026-09-07T00:00:00Z");
    const cost = geminiTurnCostUsd({ promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 130 }, before2027);

    const expected = (9 / 1_000_000) * 0.75 + (121 / 1_000_000) * 3.75;
    expect(cost).toBeCloseTo(expected, 12);

    const naive = (9 / 1_000_000) * 0.75 + (4 / 1_000_000) * 3.75;
    expect(cost).toBeGreaterThan(naive * 10);
  });

  it("never returns a negative or NaN cost for a malformed usage record", () => {
    expect(geminiTurnCostUsd(null)).toBe(0);
    expect(geminiTurnCostUsd({ promptTokenCount: -5, totalTokenCount: 3 })).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(geminiTurnCostUsd({ totalTokenCount: Number.NaN }))).toBe(false);
  });

  it("follows the published 2027 price increase", () => {
    const usage = { promptTokenCount: 1_000_000, candidatesTokenCount: 0, totalTokenCount: 1_000_000 };
    expect(geminiTurnCostUsd(usage, new Date("2026-12-01T00:00:00Z"))).toBeCloseTo(0.75, 10);
    expect(geminiTurnCostUsd(usage, new Date("2027-01-01T00:00:00Z"))).toBeCloseTo(1.5, 10);
  });
});
