import { CodexProvider, GrokProvider, withBudgetSink, type BudgetReport, type CodexProviderOptions, type GrokProviderOptions } from "@oikonomos/agent-providers";
import {
  getPlatformSpendUsd,
  getRoutine,
  getRoutineSpendUsd,
  recordSpend,
  type DatabaseOptions,
} from "@oikonomos/db";
import { resolveBudgetGate } from "@oikonomos/broker";
import type { SubprocessProviderFactories } from "@oikonomos/harness-factory/compose";
import type { GateSubprocess } from "@oikonomos/harness-factory";

export type GatedCodexOptions = Omit<CodexProviderOptions, "gateSpawn">;
export type GatedGrokOptions = Omit<GrokProviderOptions, "gateSpawn">;

/**
 * CLAUDE.md "Budget": "R30,000/month" is a South African Rand figure;
 * `BudgetReport.costUsd` is USD. This default is a documented placeholder
 * (roughly current at time of writing, TASK-143's currency decision) — NOT
 * authoritative. Override via `USD_TO_ZAR_RATE`.
 */
export const DEFAULT_USD_TO_ZAR_RATE = 18.5;
/** CLAUDE.md "Budget": "Hard ceiling R30,000/month (inference + hosting)". */
export const DEFAULT_PLATFORM_CEILING_ZAR = 30_000;

/**
 * TASK-143 scope-narrowing decision: this enforces the Codex/Grok
 * subprocess-routing inference-cost portion of the ceiling ONLY. Hosting
 * costs and the Claude-SDK chat path (`chatRunDriver.ts`) are NOT covered —
 * there is no telemetry for either today (see PLAN.md TASK-143 and the
 * TASK-163 follow-on for the SDK-path gap).
 */
export interface GatedSubprocessBudgetOptions {
  readonly db: DatabaseOptions;
  /** L1RunIdentity.runId for the run these providers are constructed for. */
  readonly runId: string;
  /** Owning routine, when known; omit/null for a run with no routine. */
  readonly routineId?: string | null;
  /** Overrides `DEFAULT_USD_TO_ZAR_RATE`; wire `process.env.USD_TO_ZAR_RATE` here. */
  readonly usdToZarRate?: number;
  /** Overrides `DEFAULT_PLATFORM_CEILING_ZAR`. */
  readonly platformCeilingZar?: number;
}

/**
 * Reads a routine's configured budget ceiling from `role_routines.definition
 * .budgetUsd` (TASK-143's investigated location — no dedicated column
 * exists, and this task's Owned_Paths does not include `routines.ts`, so it
 * reads the field via the already-exported `getRoutine`). Absent/malformed
 * data means "no configured ceiling" (null), not zero: a missing ceiling is
 * not the same as a zero-spend allowance, and must not fail closed here —
 * only a live spend-read failure fails closed (see `wrapGateWithBudget`).
 */
async function getRoutineBudgetUsd(db: DatabaseOptions, routineId: string): Promise<number | null> {
  const routine = await getRoutine(db, routineId);
  if (routine === null) {
    return null;
  }
  const value = (routine.definition as Record<string, unknown> | null)?.budgetUsd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Wraps a `GateSubprocess` with a live, per-decision budget check (matching
 * TASK-140's "live per-decision DB read, not cached/stale" precedent). Every
 * subprocess spawn (the unit of "next tool call" for the Codex/Grok path,
 * since these providers hand a whole turn to the CLI rather than
 * per-tool-call broker roundtrips) re-reads current spend before deciding.
 *
 * Fail-closed (CLAUDE.md non-negotiable 3): a DB read failure or malformed
 * routine-budget record denies the spawn rather than falling through to the
 * real gate.
 */
export function wrapGateWithBudget(gate: GateSubprocess, budget: GatedSubprocessBudgetOptions): GateSubprocess {
  return async (request) => {
    let decision;
    try {
      const routineId = budget.routineId ?? null;
      const [routineSpendUsd, routineBudgetUsd, platformSpendUsd] = await Promise.all([
        routineId === null ? Promise.resolve(null) : getRoutineSpendUsd(budget.db, routineId),
        routineId === null ? Promise.resolve(null) : getRoutineBudgetUsd(budget.db, routineId),
        getPlatformSpendUsd(budget.db),
      ]);
      const rate = budget.usdToZarRate ?? DEFAULT_USD_TO_ZAR_RATE;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
        throw new Error("USD_TO_ZAR_RATE must be a finite number > 0");
      }
      const platformCeilingZar = budget.platformCeilingZar ?? DEFAULT_PLATFORM_CEILING_ZAR;
      decision = resolveBudgetGate({
        routineSpendUsd,
        routineBudgetUsd,
        platformSpendUsd,
        platformCeilingUsd: platformCeilingZar / rate,
      });
    } catch (error) {
      // Fail closed: an unreachable DB or malformed record must never be
      // treated as "no spend recorded yet".
      const message = error instanceof Error ? error.message : String(error);
      return { allow: false, message: `budget.check_failed: ${message}` };
    }
    if (decision.decision === "deny") {
      return { allow: false, message: decision.reason };
    }
    return gate(request);
  };
}

/**
 * Wraps a provider with `withBudgetSink` so every completed turn persists a
 * real spend record via `recordSpend` — the real composition site TASK-072
 * documented as "the single interception point the week-5 per-routine
 * budget broker will attach to", now actually attached.
 */
export function withRecordedSpend<TProvider extends { id: string }>(
  provider: TProvider & Parameters<typeof withBudgetSink>[0],
  budget: GatedSubprocessBudgetOptions,
): TProvider {
  return withBudgetSink(provider, {
    async report(entry: BudgetReport): Promise<void> {
      await recordSpend(budget.db, {
        runId: budget.runId,
        routineId: budget.routineId ?? null,
        provider: entry.provider,
        model: entry.model,
        costUsd: entry.costUsd,
        tokens: entry.tokens,
      });
    },
  }) as unknown as TProvider;
}

/**
 * Production Codex/Grok factories. The gate argument is the one
 * `composeHarness` binds to L1 — callers must not construct these
 * providers with a missing or locally-invented spawn gate.
 *
 * `budget`, when provided, composes both halves of TASK-143's enforcement
 * for the Codex/Grok path: a live pre-spawn budget check (via `gate`) and
 * real spend recording (via `withBudgetSink`) on every completed turn.
 * Omitting it preserves the previous ungated construction exactly.
 */
export function createGatedSubprocessProviders(
  options: {
    readonly codex: GatedCodexOptions;
    readonly grok: GatedGrokOptions;
    readonly budget?: GatedSubprocessBudgetOptions;
  },
): SubprocessProviderFactories<CodexProvider, GrokProvider> {
  if (typeof options !== "object" || options === null) {
    throw new Error("createGatedSubprocessProviders requires provider options");
  }
  const budget = options.budget;
  return {
    createCodex: (gate) => {
      const provider = new CodexProvider({
        ...options.codex,
        gateSpawn: budget === undefined ? gate : wrapGateWithBudget(gate, budget),
      });
      return budget === undefined ? provider : withRecordedSpend(provider, budget);
    },
    createGrok: (gate) => {
      const provider = new GrokProvider({
        ...options.grok,
        gateSpawn: budget === undefined ? gate : wrapGateWithBudget(gate, budget),
      });
      return budget === undefined ? provider : withRecordedSpend(provider, budget);
    },
  };
}
