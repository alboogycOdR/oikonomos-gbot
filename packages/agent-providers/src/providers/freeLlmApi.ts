import type { AgentProvider, ProviderCapabilities, ProviderEvent, SendPromptOptions } from "../types.js";

/** The minimal fetch surface required by the OpenAI-compatible FreeLLMAPI endpoint. */
export type FreeLlmApiFetch = typeof fetch;

/** Token counts an OpenAI-compatible response reports for one turn. */
export interface FreeLlmApiUsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface FreeLlmApiProviderOptions {
  /** Full OpenAI-compatible chat-completions endpoint, e.g. http://router:3002/v1/chat/completions. */
  readonly endpoint: string;
  readonly defaultModel: string;
  /** Optional bearer token for a protected router. It is never included in an error message. */
  readonly apiKey?: string;
  /** Injectable only for deterministic tests. Production uses the platform fetch. */
  readonly fetch?: FreeLlmApiFetch;
  /**
   * Computes this turn's cost from reported token counts, used ONLY when the
   * endpoint reports no cost of its own.
   *
   * Aggregator routers (the original FreeLLMAPI case) return `usage.cost_usd`,
   * so they never need this. First-party OpenAI-compatible endpoints do not:
   * Google's returns `prompt_tokens`/`completion_tokens` and no cost at all,
   * which silently recorded every such turn as $0.00 — spend that never
   * counted against the platform ceiling. The caller knows which model it
   * configured, so it supplies the price; this adapter stays provider-neutral
   * and never embeds a pricing table.
   */
  readonly costFromUsage?: (usage: FreeLlmApiUsageTokens) => number;
}

interface CompletionResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  readonly usage?: {
    readonly cost?: unknown;
    readonly cost_usd?: unknown;
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
}

/**
 * Text-only FreeLLMAPI adapter. The router is OpenAI-chat-completions compatible;
 * it has no tool surface, and therefore cannot accidentally become an agentic path.
 */
export class FreeLlmApiProvider implements AgentProvider {
  readonly id = "free-llm-api" as const;
  readonly displayName = "FreeLLMAPI";
  readonly defaultModel: string;
  readonly availableModels: readonly string[];
  readonly capabilities: ProviderCapabilities = {
    agentic: false,
    resumableSessions: false,
    permissionPrompts: false,
    interruptible: true,
  };

  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: FreeLlmApiFetch;
  private readonly costFromUsage: ((usage: FreeLlmApiUsageTokens) => number) | undefined;
  private activeAbort: AbortController | null = null;

  constructor(options: FreeLlmApiProviderOptions) {
    if (options.endpoint.trim().length === 0) throw new Error("FreeLLMAPI endpoint must not be empty.");
    if (options.defaultModel.trim().length === 0) throw new Error("FreeLLMAPI defaultModel must not be empty.");
    this.endpoint = options.endpoint;
    this.defaultModel = options.defaultModel;
    this.availableModels = [options.defaultModel];
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? fetch;
    this.costFromUsage = options.costFromUsage;
  }

  async interrupt(): Promise<void> {
    this.activeAbort?.abort();
  }

  async *sendPrompt(options: SendPromptOptions): AsyncGenerator<ProviderEvent, void, unknown> {
    const controller = new AbortController();
    this.activeAbort = controller;
    const onCallerAbort = () => controller.abort();
    options.signal.addEventListener("abort", onCallerAbort);
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify({
          model: options.model ?? this.defaultModel,
          messages: [{ role: "user", content: options.prompt }],
          stream: false,
        }),
        signal: controller.signal,
      });
      if (options.signal.aborted) {
        yield { type: "error", message: "Interrupted by user.", fatal: false };
        return;
      }
      if (!response.ok) {
        yield { type: "error", message: `FreeLLMAPI request failed with HTTP ${response.status}.`, fatal: true };
        return;
      }
      const payload: unknown = await response.json();
      const parsed = payload as CompletionResponse;
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        yield { type: "error", message: "FreeLLMAPI response did not contain a text completion.", fatal: true };
        return;
      }
      if (content.length > 0) yield { type: "text_delta", text: content };
      yield {
        type: "turn_complete",
        sessionId: null,
        costUsd: responseCostUsd(parsed.usage, this.costFromUsage),
        durationMs: null,
        turns: 1,
      };
    } catch (error) {
      yield {
        type: "error",
        message: options.signal.aborted ? "Interrupted by user." : "FreeLLMAPI unavailable.",
        fatal: !options.signal.aborted,
      };
    } finally {
      options.signal.removeEventListener("abort", onCallerAbort);
      this.activeAbort = null;
    }
  }
}

function responseCostUsd(
  usage: CompletionResponse["usage"],
  costFromUsage: ((usage: FreeLlmApiUsageTokens) => number) | undefined,
): number {
  const reported = usage?.cost_usd ?? usage?.cost;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) return reported;

  // No cost reported. Price it from token counts when the caller told us how;
  // otherwise fall back to 0, which is what every caller got before.
  if (costFromUsage === undefined) return 0;
  const derived = costFromUsage({
    inputTokens: tokenCount(usage?.prompt_tokens),
    outputTokens: billableOutputTokens(usage),
  });
  return typeof derived === "number" && Number.isFinite(derived) && derived >= 0 ? derived : 0;
}

/**
 * Output tokens a caller will actually be billed for.
 *
 * A reasoning model's `completion_tokens` counts only the visible reply and
 * excludes its thinking tokens, while `total_tokens` includes them — a real
 * Gemini 3.7 Flash turn measured 2026-09-07 reported
 * `{prompt: 9, completion: 4, total: 130}`, so the ~117 thinking tokens were
 * 90% of the turn and every one of them is billed at the output rate. Pricing
 * on `completion_tokens` alone under-counted that turn's output ~30x.
 *
 * Uses whichever is larger, so a provider that omits `total_tokens`, or that
 * reports no thinking tokens at all, is unaffected.
 */
function billableOutputTokens(usage: CompletionResponse["usage"]): number {
  const completion = tokenCount(usage?.completion_tokens);
  const total = tokenCount(usage?.total_tokens);
  const prompt = tokenCount(usage?.prompt_tokens);
  return Math.max(completion, total - prompt >= 0 ? total - prompt : 0);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
