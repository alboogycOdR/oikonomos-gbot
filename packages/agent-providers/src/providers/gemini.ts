import type { AgentProvider, ProviderCapabilities, ProviderEvent, SendPromptOptions } from "../types.js";
import { costForUsage } from "../pricing.js";

/**
 * Local stand-in for TASK-094's governed Gemini query surface
 * (`packages/harness-factory/src/providers/gemini.ts`'s `createGeminiAdapter`).
 *
 * This package must never call the Gemini REST API, the broker, or any L1
 * port directly (ADR-001, ADR-011 §2): enforcement already happened inside
 * the injected query function, exactly like `ClaudeQueryFn` in
 * `claudeCode.ts`. `GeminiProvider` is a pure translator from whatever this
 * function resolves with into the shared `ProviderEvent` stream. The factory
 * injects the real, governed implementation at construction time.
 */
export interface GeminiUsageMetadata {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  totalTokenCount?: number | null;
}

export interface GeminiQueryResult {
  text: string;
  /** True when the governed loop denied the turn (bad key, broker deny, transport failure). */
  denied: boolean;
  deniedReason?: string;
  /** Real token counts from Gemini's REST response, when available. */
  usageMetadata?: GeminiUsageMetadata | null;
  /** Provider-native session id, if this backend supports resumption. */
  sessionId?: string | null;
}

export type GeminiQueryFn = (input: {
  prompt: string;
  cwd: string;
  model: string;
  sessionId: string | null;
  signal: AbortSignal;
}) => Promise<GeminiQueryResult>;

export interface GeminiProviderOptions {
  defaultModel: string;
  /**
   * Injected governed query function. Required to run a turn. Construction
   * without it is legal (ProviderRegistry); sendPrompt then fails closed,
   * matching ClaudeCodeProvider's own shape.
   */
  queryFn?: GeminiQueryFn;
}

const AVAILABLE_MODELS = ["gemini-3.7-flash"] as const;

/**
 * Gemini, translated over TASK-094's already-governed REST loop. Unlike
 * `codex`/`grok` (whose CLIs don't surface usage), Gemini's response carries
 * real token counts, so `turn_complete.costUsd` is computed here via
 * TASK-096's pure `costForUsage` calculator rather than reported as null.
 */
export class GeminiProvider implements AgentProvider {
  readonly id = "gemini" as const;
  readonly displayName = "Gemini";
  readonly defaultModel: string;
  readonly availableModels = AVAILABLE_MODELS;
  readonly capabilities: ProviderCapabilities = {
    agentic: false,
    resumableSessions: false,
    permissionPrompts: false,
    interruptible: true,
  };

  private readonly queryFn: GeminiQueryFn | undefined;
  private activeAbort: AbortController | null = null;

  constructor(options: GeminiProviderOptions) {
    this.defaultModel = options.defaultModel;
    this.queryFn = options.queryFn;
  }

  async interrupt(): Promise<void> {
    this.activeAbort?.abort();
  }

  async *sendPrompt(opts: SendPromptOptions): AsyncGenerator<ProviderEvent, void, unknown> {
    const queryFn = this.queryFn;
    if (!queryFn) {
      yield {
        type: "error",
        message:
          "Gemini query function was not injected. Wire it through packages/harness-factory (OIK-033).",
        fatal: true,
      };
      return;
    }

    const abortController = new AbortController();
    this.activeAbort = abortController;
    const onCallerAbort = () => abortController.abort();
    opts.signal.addEventListener("abort", onCallerAbort);

    try {
      const result = await queryFn({
        prompt: opts.prompt,
        cwd: opts.cwd,
        model: opts.model ?? this.defaultModel,
        sessionId: opts.sessionId,
        signal: abortController.signal,
      });

      if (opts.signal.aborted) {
        yield { type: "error", message: "Interrupted by user.", fatal: false };
        return;
      }

      if (result.denied) {
        yield {
          type: "error",
          message: result.deniedReason ?? "Gemini turn was denied.",
          fatal: true,
        };
        return;
      }

      if (result.text.length > 0) {
        yield { type: "text_delta", text: result.text };
      }

      const usage = result.usageMetadata ?? undefined;
      const costUsd = costForUsage({
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
      });

      yield {
        type: "turn_complete",
        sessionId: result.sessionId ?? opts.sessionId,
        costUsd,
        durationMs: null,
        turns: 1,
      };
    } catch (err) {
      if (opts.signal.aborted) {
        yield { type: "error", message: "Interrupted by user.", fatal: false };
      } else {
        yield { type: "error", message: describeError(err), fatal: true };
      }
    } finally {
      opts.signal.removeEventListener("abort", onCallerAbort);
      this.activeAbort = null;
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
