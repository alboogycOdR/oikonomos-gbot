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
 *
 * USD per 1,000,000 tokens.
 */
export const GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS = 0.75;
export const GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS = 3.75;

export interface UsageTokens {
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Returns the USD cost of one Gemini 3.7 Flash turn given input/output
 * token counts. Missing, undefined, null, or zero counts are treated as 0
 * — never throws, never returns NaN.
 */
export function costForUsage(usage: UsageTokens): number {
  const inputTokens = normalizeTokenCount(usage?.inputTokens);
  const outputTokens = normalizeTokenCount(usage?.outputTokens);

  const inputCost =
    (inputTokens / 1_000_000) * GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS;
  const outputCost =
    (outputTokens / 1_000_000) * GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS;

  return inputCost + outputCost;
}

function normalizeTokenCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}
