/**
 * Pure, model-aware cost-calculation module for Gemini usage.
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

export const GEMINI_3_1_FLASH_LITE_INPUT_USD_PER_MILLION_TOKENS = 0.25;
export const GEMINI_3_1_FLASH_LITE_OUTPUT_USD_PER_MILLION_TOKENS = 1.5;
export const GEMINI_3_5_FLASH_LITE_INPUT_USD_PER_MILLION_TOKENS = 0.3;
export const GEMINI_3_5_FLASH_LITE_OUTPUT_USD_PER_MILLION_TOKENS = 2.5;

export const GEMINI_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
] as const;
export type GeminiModel = (typeof GEMINI_MODELS)[number];
export const DEFAULT_GEMINI_MODEL: GeminiModel = "gemini-3.1-flash-lite";

interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly rateChange?: {
    readonly at: Date;
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
  };
}

/** Published paid-tier USD prices per 1M tokens, keyed by exact API model id. */
export const GEMINI_PRICING: Readonly<Record<GeminiModel, ModelPricing>> = {
  "gemini-3.7-flash": {
    inputPerMillion: GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS,
    outputPerMillion: GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS,
    rateChange: {
      at: GEMINI_3_7_FLASH_PRICE_INCREASE_AT,
      inputPerMillion: GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS_FROM_2027,
      outputPerMillion: GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS_FROM_2027,
    },
  },
  "gemini-3.1-flash-lite": {
    inputPerMillion: GEMINI_3_1_FLASH_LITE_INPUT_USD_PER_MILLION_TOKENS,
    outputPerMillion: GEMINI_3_1_FLASH_LITE_OUTPUT_USD_PER_MILLION_TOKENS,
  },
  "gemini-3.5-flash-lite": {
    inputPerMillion: GEMINI_3_5_FLASH_LITE_INPUT_USD_PER_MILLION_TOKENS,
    outputPerMillion: GEMINI_3_5_FLASH_LITE_OUTPUT_USD_PER_MILLION_TOKENS,
  },
};

/** The rates in force for a turn at `at`. */
export function ratesAt(model: string, at: Date): { readonly inputPerMillion: number; readonly outputPerMillion: number } {
  const pricing = GEMINI_PRICING[model as GeminiModel] ?? mostExpensivePricing(at);
  const rateChange = pricing.rateChange;
  if (rateChange !== undefined && at.getTime() >= rateChange.at.getTime()) {
    return { inputPerMillion: rateChange.inputPerMillion, outputPerMillion: rateChange.outputPerMillion };
  }
  return { inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion };
}

export interface UsageTokens {
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Returns the USD cost of one Gemini turn given the actual model and input/output
 * token counts. Missing, undefined, null, or zero counts are treated as 0
 * — never throws, never returns NaN.
 */
export function costForUsage(model: string, usage: UsageTokens, at: Date = new Date()): number {
  const inputTokens = normalizeTokenCount(usage?.inputTokens);
  const outputTokens = normalizeTokenCount(usage?.outputTokens);
  // Defaults to now, so every existing caller keeps today's rate until the
  // published cliff and then follows it without a code change.
  const rates = ratesAt(model, at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date());

  const inputCost = (inputTokens / 1_000_000) * rates.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * rates.outputPerMillion;

  return inputCost + outputCost;
}

/** Unknown IDs fail closed at the highest rate currently in force. */
function mostExpensivePricing(at: Date): ModelPricing {
  return Object.values(GEMINI_PRICING).reduce((highest, candidate) => {
    const candidateRates = effectiveRates(candidate, at);
    const highestRates = effectiveRates(highest, at);
    return candidateRates.inputPerMillion + candidateRates.outputPerMillion > highestRates.inputPerMillion + highestRates.outputPerMillion
      ? candidate
      : highest;
  });
}

function effectiveRates(pricing: ModelPricing, at: Date): { readonly inputPerMillion: number; readonly outputPerMillion: number } {
  if (pricing.rateChange !== undefined && at.getTime() >= pricing.rateChange.at.getTime()) {
    return pricing.rateChange;
  }
  return pricing;
}

function normalizeTokenCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}
