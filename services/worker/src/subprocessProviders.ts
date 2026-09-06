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
 * CLAUDE.md "Budget": "R350/month" is a South African Rand figure;
 * `BudgetReport.costUsd` is USD. This default is a documented placeholder
 * (roughly current at time of writing, TASK-143's currency decision) — NOT
 * authoritative. Override via `USD_TO_ZAR_RATE`.
 */
export const DEFAULT_USD_TO_ZAR_RATE = 18.5;
/** CLAUDE.md "Budget": "Hard ceiling R350/month (inference + hosting)" — reset 2026-09-06 from the earlier R30,000/month figure. */
export const DEFAULT_PLATFORM_CEILING_ZAR = 350;

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
 * reads the field via the already-exported `getRoutine`). A `budgetUsd`
 * field that is absent or not a finite non-negative number means "no
 * configured ceiling" (null) — a routine with no budget set is not the same
 * as a zero-spend allowance.
 *
 * A `routineId` that does not resolve to any `role_routines` row is a
 * DIFFERENT case: it is a dangling/inconsistent reference (the caller
 * asserted a routine owns this run, but the DB disagrees), and per
 * CLAUDE.md non-negotiable 3 that must fail closed, not silently degrade to
 * "unlimited" (REWORK finding, 2026-09-05).
 */
async function getRoutineBudgetUsd(db: DatabaseOptions, routineId: string): Promise<number | null> {
  const routine = await getRoutine(db, routineId);
  if (routine === null) {
    throw new Error(`budget.dangling_routine: routine ${routineId} not found`);
  }
  const value = (routine.definition as Record<string, unknown> | null)?.budgetUsd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Bounded deadline for the live budget-decision DB reads (CLAUDE.md
 * non-negotiable 3: "timeout (>10s) ⇒ deny"). A connected-but-blocked query
 * has no outer deadline of its own (`packages/db`'s pool only bounds
 * connection *acquisition*, not an in-flight query) — race it against this
 * timer so a stuck read denies instead of hanging (REWORK finding,
 * 2026-09-05).
 */
export const BUDGET_READ_TIMEOUT_MS = 9_500;

function withBudgetReadTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`budget.read_timeout: exceeded ${BUDGET_READ_TIMEOUT_MS}ms`));
    }, BUDGET_READ_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/**
 * Wraps a `GateSubprocess` with a live, per-decision budget check (matching
 * TASK-140's "live per-decision DB read, not cached/stale" precedent). Every
 * subprocess spawn (the unit of "next tool call" for the Codex/Grok path,
 * since these providers hand a whole turn to the CLI rather than
 * per-tool-call broker roundtrips) re-reads current spend before deciding.
 *
 * Fail-closed (CLAUDE.md non-negotiable 3): a DB read failure, a read that
 * exceeds `BUDGET_READ_TIMEOUT_MS`, a dangling routine reference, or a
 * malformed ceiling/rate config all deny the spawn rather than falling
 * through to the real gate.
 *
 * **Known accepted limitation (TOCTOU, documented per the REWORK finding
 * rather than silently assumed correct):** this check and `withRecordedSpend`
 * are not one atomic transaction. Concurrent spawns can each read the same
 * pre-spend total, all pass, then each record cost afterward — able to
 * exceed a ceiling by multiple in-flight turns' worth of spend before the
 * next spawn's read observes it. A full fix needs a transactional
 * reservation (e.g. an atomic "reserve then confirm/release" spend row,
 * mirroring the nonce-consumption pattern CLAUDE.md non-negotiable 8 uses
 * for approvals) — tracked as follow-on work, not built in this session.
 * Accepted for now because: subprocess spawns are turn-granular (not
 * per-tool-call), so the worst-case overshoot is bounded by concurrent
 * in-flight turns, and the platform ceiling is a soft monthly guardrail,
 * not a hard per-call limit like the ACL/approval controls.
 */
export function wrapGateWithBudget(gate: GateSubprocess, budget: GatedSubprocessBudgetOptions): GateSubprocess {
  return async (request) => {
    let decision;
    try {
      // Validate config BEFORE any I/O: fails fast on a malformed rate/
      // ceiling without spending a DB round trip, and keeps this branch
      // testable without a live database (REWORK fix, 2026-09-05).
      const rate = budget.usdToZarRate ?? DEFAULT_USD_TO_ZAR_RATE;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
        throw new Error("USD_TO_ZAR_RATE must be a finite number > 0");
      }
      const platformCeilingZar = budget.platformCeilingZar ?? DEFAULT_PLATFORM_CEILING_ZAR;
      if (
        typeof platformCeilingZar !== "number" ||
        !Number.isFinite(platformCeilingZar) ||
        platformCeilingZar < 0
      ) {
        throw new Error("platformCeilingZar must be a finite number >= 0");
      }

      const routineId = budget.routineId ?? null;
      const [routineSpendUsd, routineBudgetUsd, platformSpendUsd] = await withBudgetReadTimeout(
        Promise.all([
          routineId === null ? Promise.resolve(null) : getRoutineSpendUsd(budget.db, routineId),
          routineId === null ? Promise.resolve(null) : getRoutineBudgetUsd(budget.db, routineId),
          getPlatformSpendUsd(budget.db),
        ]),
      );
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
 *
 * **Liveness assertion (REWORK session 3, 2026-09-05):** `budget` is now a
 * hard-required argument — omitting it throws unless the caller explicitly
 * opts out via `unsafeAllowUnbudgeted: true`. This closes the "inert in
 * production" finding at the type level: no future integrator can silently
 * construct an unbudgeted Codex/Grok provider by simply forgetting the
 * `budget` option the way the previous optional-parameter shape allowed.
 * ORCH's own root-cause fix (correcting the `Owned_Paths` typo,
 * `src/executeRun.test.ts` -> `test/executeRun.test.ts`, the file that
 * actually exists) is what unblocked this: that test now legitimately sits
 * in-territory and is updated alongside this change (see its own commit).
 */
export function createGatedSubprocessProviders(
  options: {
    readonly codex: GatedCodexOptions;
    readonly grok: GatedGrokOptions;
    readonly budget?: GatedSubprocessBudgetOptions;
    /**
     * Explicit, auditable opt-out of budget enforcement. Must be `true` if
     * `budget` is omitted — CLAUDE.md's control-liveness rule requires a
     * caller to say "I mean to skip enforcement" rather than silently
     * doing so by forgetting an optional field.
     */
    readonly unsafeAllowUnbudgeted?: boolean;
  },
): SubprocessProviderFactories<CodexProvider, GrokProvider> {
  if (typeof options !== "object" || options === null) {
    throw new Error("createGatedSubprocessProviders requires provider options");
  }
  const budget = options.budget;
  if (budget === undefined && options.unsafeAllowUnbudgeted !== true) {
    throw new Error(
      "createGatedSubprocessProviders requires a `budget` option (TASK-143 enforcement) " +
        "— pass `unsafeAllowUnbudgeted: true` to explicitly construct unbudgeted Codex/Grok providers.",
    );
  }
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
