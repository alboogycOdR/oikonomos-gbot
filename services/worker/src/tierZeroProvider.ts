import { FreeLlmApiProvider, withBudgetSink, type FreeLlmApiFetch } from "@oikonomos/agent-providers";
import {
  getPlatformSpendUsd,
  getRoutine,
  getRoutineSpendUsd,
  recordSpend,
  type DatabaseOptions,
} from "@oikonomos/db";
import { resolveBudgetGate } from "@oikonomos/broker";

/** Kept aligned with the existing subprocess budget composition. */
export const DEFAULT_USD_TO_ZAR_RATE = 18.5;
export const DEFAULT_PLATFORM_CEILING_ZAR = 30_000;
export const BUDGET_READ_TIMEOUT_MS = 9_500;

export interface CreateTierZeroProviderOptions {
  readonly db: DatabaseOptions;
  readonly runId: string;
  readonly routineId?: string | null;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly usdToZarRate?: number;
  readonly platformCeilingZar?: number;
  /** Injectable only for deterministic tests. */
  readonly fetch?: FreeLlmApiFetch;
}

/** A governed, text-only Tier-0 completion call suitable for routing and compaction. */
export type TierZeroProvider = (prompt: string) => Promise<string>;

/**
 * Constructs the sole FreeLLMAPI Tier-0 seam. Each invocation first makes a
 * live, fail-closed budget decision, then records its completed turn through
 * the generic agent-providers budget decorator used by the other providers.
 */
export function createTierZeroProvider(options: CreateTierZeroProviderOptions): TierZeroProvider {
  validateOptions(options);
  const provider = withBudgetSink(
    new FreeLlmApiProvider({
      endpoint: options.endpoint,
      defaultModel: options.model,
      apiKey: options.apiKey,
      fetch: options.fetch,
    }),
    {
      async report(entry): Promise<void> {
        await recordSpend(options.db, {
          runId: options.runId,
          routineId: options.routineId ?? null,
          provider: entry.provider,
          model: entry.model,
          costUsd: entry.costUsd,
          tokens: entry.tokens,
        });
      },
    },
  );

  return async (prompt: string): Promise<string> => {
    if (prompt.trim().length === 0) throw new Error("Tier-0 prompt must not be empty.");
    await assertBudgetAllowsCall(options);
    const text: string[] = [];
    let completed = false;
    for await (const event of provider.sendPrompt({
      prompt,
      cwd: "",
      sessionId: null,
      model: null,
      signal: new AbortController().signal,
    })) {
      if (event.type === "text_delta") text.push(event.text);
      if (event.type === "error") throw new Error(`Tier-0 provider failed: ${event.message}`);
      if (event.type === "turn_complete") completed = true;
    }
    if (!completed) throw new Error("Tier-0 provider ended before its spend could be recorded.");
    return text.join("");
  };
}

async function assertBudgetAllowsCall(options: CreateTierZeroProviderOptions): Promise<void> {
  let decision;
  try {
    const [routineSpendUsd, routineBudgetUsd, platformSpendUsd] = await withBudgetReadTimeout(
      Promise.all([
        options.routineId === undefined || options.routineId === null
          ? Promise.resolve(null)
          : getRoutineSpendUsd(options.db, options.routineId),
        options.routineId === undefined || options.routineId === null
          ? Promise.resolve(null)
          : getRoutineBudgetUsd(options.db, options.routineId),
        getPlatformSpendUsd(options.db),
      ]),
    );
    decision = resolveBudgetGate({
      routineSpendUsd,
      routineBudgetUsd,
      platformSpendUsd,
      platformCeilingUsd: (options.platformCeilingZar ?? DEFAULT_PLATFORM_CEILING_ZAR) /
        (options.usdToZarRate ?? DEFAULT_USD_TO_ZAR_RATE),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`budget.check_failed: ${message}`);
  }
  if (decision.decision === "deny") throw new Error(decision.reason);
}

async function getRoutineBudgetUsd(db: DatabaseOptions, routineId: string): Promise<number | null> {
  const routine = await getRoutine(db, routineId);
  if (routine === null) throw new Error(`budget.dangling_routine: routine ${routineId} not found`);
  const budget = (routine.definition as Record<string, unknown>).budgetUsd;
  return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : null;
}

function validateOptions(options: CreateTierZeroProviderOptions): void {
  if (options.runId.trim().length === 0) throw new Error("Tier-0 runId must not be empty.");
  const rate = options.usdToZarRate ?? DEFAULT_USD_TO_ZAR_RATE;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("Tier-0 usdToZarRate must be a finite number > 0.");
  }
  const ceiling = options.platformCeilingZar ?? DEFAULT_PLATFORM_CEILING_ZAR;
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0) {
    throw new Error("Tier-0 platformCeilingZar must be a finite number >= 0.");
  }
}

function withBudgetReadTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`budget.read_timeout: exceeded ${BUDGET_READ_TIMEOUT_MS}ms`)), BUDGET_READ_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
