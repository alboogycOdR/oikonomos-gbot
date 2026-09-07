/**
 * Pure cost-calculation module for Gemini 3.7 Flash usage.
 *
 * No I/O, no network calls, no filesystem access, no process.env reads.
 * TASK-095's GeminiProvider imports and calls this — this module does not
 * wire itself into anything.
 */

/**
 * Gemini 3.7 Flash published introductory pricing, confirmed live
 * 2026-09-02 against https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash
 * and re-verified 2026-09-07 against https://ai.google.dev/gemini-api/docs/pricing
 *
 * USD per 1,000,000 tokens.
 */
export const GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS = 0.75;
export const GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS = 3.75;

/**
 * The published price doubles on 2027-01-01 (TASK-217).
 *
 * Google's pricing page states the introductory rates apply "through
 * December 31, 2026", with $1.50 / $7.50 per 1M "starting January 1, 2027".
 * That is a DATED, published cliff, not a forecast — so the risk is not that
 * we cannot know, it is that nothing in the system would notice. On that day
 * every Gemini turn would be costed at half its real price, the platform
 * ceiling and TASK-209's per-provider cap would each permit roughly double
 * the intended spend, and no test, log or dashboard would look wrong.
 *
 * Encoded as a date-dependent rate rather than a comment, because a comment
 * warning about a future date is only as good as whoever happens to read it
 * that week.
 */
export const GEMINI_3_7_FLASH_PRICE_INCREASE_AT = new Date("2027-01-01T00:00:00Z");
export const GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS_FROM_2027 = 1.5;
export const GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS_FROM_2027 = 7.5;

/** The rates in force for a turn at `at`. */
export function ratesAt(at: Date): { readonly inputPerMillion: number; readonly outputPerMillion: number } {
  return at.getTime() >= GEMINI_3_7_FLASH_PRICE_INCREASE_AT.getTime()
    ? {
      inputPerMillion: GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS_FROM_2027,
      outputPerMillion: GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS_FROM_2027,
    }
    : {
      inputPerMillion: GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS,
      outputPerMillion: GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS,
    };
}

export interface UsageTokens {
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Returns the USD cost of one Gemini 3.7 Flash turn given input/output
 * token counts. Missing, undefined, null, or zero counts are treated as 0
 * — never throws, never returns NaN.
 */
export function costForUsage(usage: UsageTokens, at: Date = new Date()): number {
  const inputTokens = normalizeTokenCount(usage?.inputTokens);
  const outputTokens = normalizeTokenCount(usage?.outputTokens);
  // Defaults to now, so every existing caller keeps today's rate until the
  // published cliff and then follows it without a code change.
  const rates = ratesAt(at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date());

  const inputCost = (inputTokens / 1_000_000) * rates.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * rates.outputPerMillion;

  return inputCost + outputCost;
}

function normalizeTokenCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}
