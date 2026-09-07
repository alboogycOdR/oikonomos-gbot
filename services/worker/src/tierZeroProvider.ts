import { costForUsage, FreeLlmApiProvider, withBudgetSink, type FreeLlmApiFetch } from "@oikonomos/agent-providers";
import {
  getPlatformSpendUsd,
  getRoutine,
  getRoutineSpendUsd,
  recordSpend,
  type DatabaseOptions,
} from "@oikonomos/db";
import { resolveBudgetGate } from "@oikonomos/broker";

/**
 * Re-exported from the single canonical definition rather than redeclared.
 *
 * These were duplicated literals, and the copy here went stale: it still
 * said 30_000 after the platform ceiling was reset to R350 on 2026-09-06
 * (CLAUDE.md § Budget). Because `resolveTierZeroProviderOptions` in
 * chatRunDriver.ts passes only endpoint/model/apiKey, every production
 * Tier-0 call — context compaction and unaddressed group-message routing —
 * fell through to that stale default and was budget-gated at ~86x the real
 * ceiling. A duplicated constant cannot go stale if there is only one.
 */
import { DEFAULT_PLATFORM_CEILING_ZAR, DEFAULT_USD_TO_ZAR_RATE } from "./subprocessProviders.js";
export { DEFAULT_PLATFORM_CEILING_ZAR, DEFAULT_USD_TO_ZAR_RATE };
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
  /**
   * Prices a turn from token counts when the endpoint reports no cost of its
   * own. Google's OpenAI-compatible endpoint returns token counts and no
   * cost, so without this every Gemini-backed Tier-0 turn records $0.00 and
   * never counts against the platform ceiling.
   */
  readonly costFromUsage?: (usage: { readonly inputTokens: number; readonly outputTokens: number }) => number;
  /**
   * Provider name recorded against this call's spend. The transport is
   * `FreeLlmApiProvider` whichever backend is configured, so its own id
   * ("free-llm-api") would attribute Gemini spend to the wrong provider and
   * make per-provider cost reporting wrong at exactly the moment it starts
   * to matter. Defaults to the transport's id when unset.
   */
  readonly providerId?: string;
}

/** Google's OpenAI-compatible chat-completions surface. */
export const GEMINI_OPENAI_COMPATIBLE_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
/** ADR-011's chosen Gemini model; matches packages/agent-providers' price table. */
export const GEMINI_TIER_ZERO_MODEL = "gemini-3.7-flash";

/**
 * Tier-0 configuration derived from the environment.
 *
 * Prefers Gemini (ADR-011's accepted provider) whenever `GEMINI_API_KEY` is
 * set, falling back to whatever `FREE_LLM_API_*` points at. Tier-0 is
 * text-only with no tool surface, so ADR-011 §3's Stage-1 boundary
 * (observation only, no tool execution) is satisfied by construction — this
 * routing does not touch the tool-executing path its §7 addendum gates.
 *
 * Returns `undefined` when neither provider is configured, so the caller can
 * raise its own error naming what to set.
 */
export function resolveTierZeroEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): Pick<CreateTierZeroProviderOptions, "endpoint" | "model" | "apiKey" | "costFromUsage" | "providerId"> | undefined {
  const geminiKey = env.GEMINI_API_KEY?.trim();
  if (geminiKey !== undefined && geminiKey.length > 0) {
    return {
      endpoint: GEMINI_OPENAI_COMPATIBLE_ENDPOINT,
      model: env.GEMINI_TIER_ZERO_MODEL?.trim() || GEMINI_TIER_ZERO_MODEL,
      apiKey: geminiKey,
      costFromUsage: costForUsage,
      providerId: "gemini",
    };
  }
  const endpoint = env.FREE_LLM_API_ENDPOINT?.trim();
  const model = env.FREE_LLM_API_MODEL?.trim();
  if (endpoint === undefined || endpoint.length === 0) return undefined;
  if (model === undefined || model.length === 0) return undefined;
  const apiKey = env.FREE_LLM_API_KEY?.trim();
  return { endpoint, model, ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }) };
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
      ...(options.costFromUsage === undefined ? {} : { costFromUsage: options.costFromUsage }),
    }),
    {
      async report(entry): Promise<void> {
        await recordSpend(options.db, {
          runId: options.runId,
          routineId: options.routineId ?? null,
          provider: options.providerId ?? entry.provider,
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
