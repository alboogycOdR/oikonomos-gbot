import type { AgentProvider, ProviderCapabilities, ProviderEvent, SendPromptOptions } from "../types.js";

/** The minimal fetch surface required by the OpenAI-compatible FreeLLMAPI endpoint. */
export type FreeLlmApiFetch = typeof fetch;

export interface FreeLlmApiProviderOptions {
  /** Full OpenAI-compatible chat-completions endpoint, e.g. http://router:3002/v1/chat/completions. */
  readonly endpoint: string;
  readonly defaultModel: string;
  /** Optional bearer token for a protected router. It is never included in an error message. */
  readonly apiKey?: string;
  /** Injectable only for deterministic tests. Production uses the platform fetch. */
  readonly fetch?: FreeLlmApiFetch;
}

interface CompletionResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  readonly usage?: { readonly cost?: unknown; readonly cost_usd?: unknown };
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
  private activeAbort: AbortController | null = null;

  constructor(options: FreeLlmApiProviderOptions) {
    if (options.endpoint.trim().length === 0) throw new Error("FreeLLMAPI endpoint must not be empty.");
    if (options.defaultModel.trim().length === 0) throw new Error("FreeLLMAPI defaultModel must not be empty.");
    this.endpoint = options.endpoint;
    this.defaultModel = options.defaultModel;
    this.availableModels = [options.defaultModel];
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? fetch;
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
        costUsd: responseCostUsd(parsed.usage),
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

function responseCostUsd(usage: CompletionResponse["usage"]): number {
  const value = usage?.cost_usd ?? usage?.cost;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
