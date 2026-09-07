import { costForUsage } from "@oikonomos/agent-providers";
import { resolveBudgetGate, resolveProviderCapUsd, type BudgetGateDecision } from "@oikonomos/broker";
import {
  getPlatformSpendUsd,
  getProviderSpendUsd,
  getRoutineSpendUsd,
  startOfCurrentMonthUtc,
  type DatabaseOptions,
} from "@oikonomos/db";

/**
 * The Gemini lane's budget gate (TASK-215).
 *
 * Wave 2 merged an adapter, sandbox-backed executors and a raised tool
 * ceiling — three pieces with no caller between them, so every one could be
 * green while the product was unchanged. This module is the missing caller's
 * governance half: it decides whether a tool-executing Gemini turn may run
 * at all, before any of that machinery is constructed.
 */

/** The provider label spend is recorded and capped under. Must match `recordSpend`. */
export const GEMINI_PROVIDER_ID = "gemini";

export interface GeminiBudgetInput {
  readonly db: DatabaseOptions;
  readonly routineId: string | null;
  readonly routineBudgetUsd: number | null;
  readonly platformCeilingUsd: number;
  /** Reads the configured cap; injectable so a test need not mutate process.env. */
  readonly resolveCap?: (provider: string) => number | null;
  /** Fixes the accounting window; defaults to the current UTC calendar month. */
  readonly since?: Date;
}

export type GeminiBudgetDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string };

/**
 * ADR-011 §7: `gemini-3.7-flash` must not become an uncapped default for
 * tool-executing runs.
 *
 * `resolveProviderCapUsd` returning `null` means "no cap configured", which
 * is correct for the pure gate — an unconfigured provider is simply bounded
 * by the platform ceiling. It is NOT acceptable here. This is the exact path
 * §7 names, so an absent cap DENIES rather than falling through: the
 * difference between "nobody set a limit" and "the limit is the platform
 * ceiling" is the whole of that amendment. Raised by Fable's TASK-209 review,
 * which required the obligation live on the wiring rather than in the gate.
 */
export const GEMINI_CAP_MISSING_REASON = "budget.provider_cap_unset";

export async function resolveGeminiBudget(input: GeminiBudgetInput): Promise<GeminiBudgetDecision> {
  try {
    const resolveCap = input.resolveCap ?? resolveProviderCapUsd;
    // Inside the try: a malformed cap throws, and must convert to a deny like
    // every other budget read rather than escaping as an unhandled error.
    const capUsd = resolveCap(GEMINI_PROVIDER_ID);
    if (capUsd === null) {
      return { decision: "deny", reason: GEMINI_CAP_MISSING_REASON };
    }

    // ONE instant for both reads. They default independently, so left to
    // themselves they resolve at two different times and the provider total
    // can be measured over a different window than the platform total — a cap
    // compared against a differently-scoped figure is a coincidence, not a
    // cap (Fable, TASK-209 review).
    const since = input.since ?? startOfCurrentMonthUtc();
    const [platformSpendUsd, providerSpendUsd, routineSpendUsd] = await Promise.all([
      getPlatformSpendUsd(input.db, since),
      getProviderSpendUsd(input.db, GEMINI_PROVIDER_ID, since),
      input.routineId === null ? Promise.resolve(null) : getRoutineSpendUsd(input.db, input.routineId),
    ]);

    const decision: BudgetGateDecision = resolveBudgetGate({
      routineSpendUsd,
      routineBudgetUsd: input.routineBudgetUsd,
      platformSpendUsd,
      platformCeilingUsd: input.platformCeilingUsd,
      provider: { provider: GEMINI_PROVIDER_ID, spendUsd: providerSpendUsd, capUsd },
    });
    return decision.decision === "allow"
      ? { decision: "allow" }
      : { decision: "deny", reason: decision.reason };
  } catch (error) {
    // Fail closed (CLAUDE.md non-negotiable 3): a budget read that cannot run
    // is not evidence of headroom.
    const message = error instanceof Error ? error.message : String(error);
    return { decision: "deny", reason: `budget.check_failed: ${message}` };
  }
}

/**
 * Prices a completed Gemini turn from its own reported token counts.
 *
 * Gemini reports `promptTokenCount`/`candidatesTokenCount` alongside a
 * `totalTokenCount` that also includes THINKING tokens, which Google bills at
 * the output rate. Billable output is therefore derived from the total, not
 * from the candidate count: a real turn measured 2026-09-07 reported
 * 9/4/130, so pricing on the candidate count alone under-counted that turn's
 * output roughly thirty-fold (see `e4b8289`).
 */
export function geminiTurnCostUsd(
  usage: { promptTokenCount?: number | null; candidatesTokenCount?: number | null; totalTokenCount?: number | null } | null | undefined,
  at: Date = new Date(),
): number {
  const inputTokens = nonNegative(usage?.promptTokenCount);
  const candidates = nonNegative(usage?.candidatesTokenCount);
  const total = nonNegative(usage?.totalTokenCount);
  const outputTokens = Math.max(candidates, total - inputTokens >= 0 ? total - inputTokens : 0);
  return costForUsage({ inputTokens, outputTokens }, at);
}

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
