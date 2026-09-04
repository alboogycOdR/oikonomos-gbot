import type { AgentSdkQueryFn } from "./ports.js";

/** Cost report emitted for each cost-bearing Claude Agent SDK result event. */
export interface BudgetTapReport {
  /** SDK `total_cost_usd`: a cumulative estimate for the query pipeline. */
  costUsd: number;
  /**
   * Sum of all reported model input, output, and cache token counts when the
   * SDK result supplies a complete `modelUsage` record.
   */
  tokens?: number;
}

/** Injected by the future spend ledger/budget broker composition root. */
export interface BudgetTapSink {
  report(entry: BudgetTapReport): Promise<void> | void;
}

/** Raised when the tap cannot account for a cost-bearing SDK result. */
export class BudgetTapError extends Error {
  readonly report: BudgetTapReport;
  readonly cause: unknown;

  constructor(report: BudgetTapReport, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Budget tap rejected SDK result costing $${report.costUsd}: ${causeMessage}`);
    this.name = "BudgetTapError";
    this.report = report;
    this.cause = cause;
  }
}

/**
 * Wraps an Agent SDK query function, accounting for each terminal SDK
 * `result` event before it reaches the caller. Events are otherwise yielded
 * unchanged. A sink failure fails closed: the cost-bearing event is withheld
 * and the caller receives `BudgetTapError` instead.
 *
 * Streams with no cost-bearing `result` event are valid (notably test fakes)
 * and finish without calling the sink.
 */
export function withBudgetTap(queryFn: AgentSdkQueryFn, sink: BudgetTapSink): AgentSdkQueryFn {
  return (input) => tapQuery(queryFn(input), sink);
}

async function* tapQuery(
  stream: AsyncIterable<unknown>,
  sink: BudgetTapSink,
): AsyncGenerator<unknown, void, unknown> {
  for await (const event of stream) {
    const report = reportFromSdkResult(event);
    if (report !== undefined) {
      try {
        await sink.report(report);
      } catch (cause) {
        throw new BudgetTapError(report, cause);
      }
    }
    yield event;
  }
}

function reportFromSdkResult(event: unknown): BudgetTapReport | undefined {
  if (!isRecord(event) || event.type !== "result" || !isNonNegativeFiniteNumber(event.total_cost_usd)) {
    return undefined;
  }

  const tokens = tokensFromModelUsage(event.modelUsage);
  return tokens === undefined
    ? { costUsd: event.total_cost_usd }
    : { costUsd: event.total_cost_usd, tokens };
}

function tokensFromModelUsage(modelUsage: unknown): number | undefined {
  if (!isRecord(modelUsage)) {
    return undefined;
  }

  let tokens = 0;
  for (const usage of Object.values(modelUsage)) {
    if (!isRecord(usage)) {
      return undefined;
    }
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
    ]) {
      if (!isNonNegativeFiniteNumber(usage[field])) {
        return undefined;
      }
      tokens += usage[field];
    }
  }
  return tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
