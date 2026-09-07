import {
  costForUsage,
  GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS,
  GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS,
  GEMINI_3_7_FLASH_PRICE_INCREASE_AT,
} from "./pricing.js";

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("costForUsage", () => {
    it("returns 0.75 for 1M input tokens, 0 output tokens", () => {
      expect(costForUsage({ inputTokens: 1_000_000, outputTokens: 0 })).toBe(
        0.75,
      );
    });

    it("returns 3.75 for 0 input tokens, 1M output tokens", () => {
      expect(costForUsage({ inputTokens: 0, outputTokens: 1_000_000 })).toBe(
        3.75,
      );
    });

    it("returns the summed cost for a mixed usage case", () => {
      // 500,000 input tokens -> 0.375; 200,000 output tokens -> 0.75
      expect(
        costForUsage({ inputTokens: 500_000, outputTokens: 200_000 }),
      ).toBeCloseTo(0.375 + 0.75, 10);
    });

    it("treats zero token counts as zero cost", () => {
      expect(costForUsage({ inputTokens: 0, outputTokens: 0 })).toBe(0);
    });

    it("treats undefined token counts as zero cost without throwing", () => {
      expect(() => costForUsage({})).not.toThrow();
      expect(costForUsage({})).toBe(0);
    });

    it("treats missing fields (undefined properties) as zero cost", () => {
      expect(
        costForUsage({ inputTokens: undefined, outputTokens: undefined }),
      ).toBe(0);
    });

    it("treats null token counts as zero cost without throwing", () => {
      // No @ts-expect-error here: UsageTokens deliberately types both
      // fields as `number | null` so this call is not a type error.
      expect(costForUsage({ inputTokens: null, outputTokens: null })).toBe(0);
    });

    it("never returns NaN for degenerate input", () => {
      expect(
        Number.isNaN(
          // @ts-expect-error - exercising runtime handling of non-numeric input
          costForUsage({ inputTokens: "oops" }),
        ),
      ).toBe(false);
    });

    it("exports named pricing constants matching published rates", () => {
      expect(GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS).toBe(0.75);
      expect(GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS).toBe(3.75);
    });

    // TASK-217 — Google publishes the introductory rate as applying "through
    // December 31, 2026", doubling on January 1, 2027. A dated, published
    // cliff: the risk was never that we could not know, only that nothing
    // would notice. Both sides are asserted at the exact instant.
    it("prices a turn at the introductory rate right up to the cliff", () => {
      const justBefore = new Date(GEMINI_3_7_FLASH_PRICE_INCREASE_AT.getTime() - 1);
      expect(costForUsage({ inputTokens: 1_000_000, outputTokens: 0 }, justBefore)).toBeCloseTo(0.75, 10);
      expect(costForUsage({ inputTokens: 0, outputTokens: 1_000_000 }, justBefore)).toBeCloseTo(3.75, 10);
    });

    it("prices a turn at the increased rate from the exact instant of the cliff", () => {
      const atCliff = new Date(GEMINI_3_7_FLASH_PRICE_INCREASE_AT.getTime());
      expect(costForUsage({ inputTokens: 1_000_000, outputTokens: 0 }, atCliff)).toBeCloseTo(1.5, 10);
      expect(costForUsage({ inputTokens: 0, outputTokens: 1_000_000 }, atCliff)).toBeCloseTo(7.5, 10);
      // Well after the cliff, unchanged.
      expect(costForUsage({ inputTokens: 1_000_000, outputTokens: 0 }, new Date("2027-06-01T00:00:00Z"))).toBeCloseTo(1.5, 10);
    });

    it("would under-report by exactly half if the cliff were ignored", () => {
      // States the consequence the guard prevents: the platform ceiling and
      // the per-provider cap would each permit ~2x the intended spend.
      const after = new Date("2027-02-01T00:00:00Z");
      const before = new Date("2026-12-01T00:00:00Z");
      const usage = { inputTokens: 500_000, outputTokens: 250_000 };
      expect(costForUsage(usage, after)).toBeCloseTo(costForUsage(usage, before) * 2, 10);
    });

    it("falls back to now for a missing or invalid date rather than mispricing", () => {
      expect(costForUsage({ inputTokens: 1_000_000, outputTokens: 0 }, new Date("not-a-date")))
        .toBe(costForUsage({ inputTokens: 1_000_000, outputTokens: 0 }));
    });
  });
}
