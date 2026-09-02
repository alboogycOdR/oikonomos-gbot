import {
  costForUsage,
  GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS,
  GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS,
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
  });
}
