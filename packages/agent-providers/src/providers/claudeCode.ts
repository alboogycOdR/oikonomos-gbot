import type { ClaudePermissionMode } from "../config.js";
import type {
  AgentProvider,
  ProviderCapabilities,
  ProviderEvent,
  SendPromptOptions,
} from "../types.js";

/**
 * Local stand-in for the Claude Agent SDK `query()` surface.
 *
 * This package must not import `@anthropic-ai/claude-agent-sdk` (lint
 * `no-direct-agent-sdk-query` + ADR-001: harness construction is OIK-033).
 * The factory injects the real `query` at construction time.
 */
export interface ClaudeQueryAllow {
  behavior: "allow";
  updatedInput: Record<string, unknown>;
}

export interface ClaudeQueryDeny {
  behavior: "deny";
  message: string;
}

export type ClaudeQueryToolDecision = ClaudeQueryAllow | ClaudeQueryDeny;

export interface ClaudeQueryCallOpts {
  requestId: string;
  title?: string;
}

export interface ClaudeQueryOptions {
  cwd: string;
  model: string;
  resume?: string;
  permissionMode: ClaudePermissionMode;
  systemPrompt: { type: "preset"; preset: "claude_code" };
  settingSources: Array<"project"> | [];
  abortController: AbortController;
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    callOpts: ClaudeQueryCallOpts,
  ) => Promise<ClaudeQueryToolDecision>;
}

export interface ClaudeAssistantMessage {
  type: "assistant";
  session_id: string;
  message: {
    content: unknown;
  };
}

export interface ClaudeUserMessage {
  type: "user";
  session_id?: string;
  message: {
    content: unknown;
  };
}

export interface ClaudeResultSuccess {
  type: "result";
  subtype: "success";
  session_id: string;
  total_cost_usd: number | null;
  duration_ms: number | null;
  num_turns: number | null;
}

export interface ClaudeResultFailure {
  type: "result";
  subtype: string;
  session_id: string;
}

export type ClaudeQueryMessage =
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeResultSuccess
  | ClaudeResultFailure
  | { type: string; [key: string]: unknown };

export type ClaudeQueryFn = (input: {
  prompt: string;
  options: ClaudeQueryOptions;
}) => AsyncIterable<ClaudeQueryMessage>;

export interface ClaudeCodeProviderOptions {
  defaultModel: string;
  permissionMode: ClaudePermissionMode;
  /** When true, skip all filesystem settings (CLAUDE.md, .claude/settings.json). */
  strictSettings?: boolean;
  /**
   * Injected Agent SDK `query`. Required to run a turn. Construction
   * without it is legal (ProviderRegistry); sendPrompt then fails closed.
   */
  queryFn?: ClaudeQueryFn;
}

const AVAILABLE_MODELS = [
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;

/**
 * Full agentic coding via an injected Claude Agent SDK `query`. Streams
 * results turn-by-turn and routes permission prompts through the
 * caller-supplied `onPermissionRequest` callback.
 */
export class ClaudeCodeProvider implements AgentProvider {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly defaultModel: string;
  readonly availableModels = AVAILABLE_MODELS;
  readonly capabilities: ProviderCapabilities = {
    agentic: true,
    resumableSessions: true,
    permissionPrompts: true,
    interruptible: true,
  };

  private readonly permissionMode: ClaudePermissionMode;
  private readonly strictSettings: boolean;
  private readonly queryFn: ClaudeQueryFn | undefined;
  private activeAbort: AbortController | null = null;

  constructor(options: ClaudeCodeProviderOptions) {
    this.defaultModel = options.defaultModel;
    this.permissionMode = options.permissionMode;
    this.strictSettings = options.strictSettings ?? false;
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
          "Claude Code query function was not injected. Wire it through packages/harness-factory (OIK-033).",
        fatal: true,
      };
      return;
    }

    const abortController = new AbortController();
    this.activeAbort = abortController;
    const onCallerAbort = () => abortController.abort();
    opts.signal.addEventListener("abort", onCallerAbort);

    const openToolUses = new Map<string, { toolName: string }>();

    let finalSessionId: string | null = opts.sessionId;
    let sawFatalError = false;

    try {
      const q = queryFn({
        prompt: opts.prompt,
        options: {
          cwd: opts.cwd,
          model: opts.model ?? this.defaultModel,
          resume: opts.sessionId ?? undefined,
          permissionMode: this.permissionMode,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: this.strictSettings ? [] : ["project"],
          abortController,
          canUseTool: opts.onPermissionRequest
            ? async (toolName, input, callOpts) => {
                const decision = await opts.onPermissionRequest!({
                  type: "permission_request",
                  requestId: callOpts.requestId,
                  toolName,
                  input,
                  summary: callOpts.title ?? `${toolName}(${summarizeInput(input)})`,
                });

                if (decision.allow) {
                  return { behavior: "allow" as const, updatedInput: input };
                }
                return {
                  behavior: "deny" as const,
                  message: decision.reason ?? "Denied by user via Telegram.",
                };
              }
            : undefined,
        },
      });

      for await (const message of q) {
        if (message.type === "assistant") {
          const assistant = message as ClaudeAssistantMessage;
          finalSessionId = assistant.session_id;
          const content = assistant.message.content;
          if (!Array.isArray(content)) continue;

          for (const block of content) {
            if (!isRecord(block) || typeof block.type !== "string") continue;
            if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
              yield { type: "text_delta", text: block.text };
            } else if (
              block.type === "thinking" &&
              typeof block.thinking === "string" &&
              block.thinking.length > 0
            ) {
              yield { type: "thinking_delta", text: block.thinking };
            } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
              openToolUses.set(block.id, { toolName: block.name });
              yield {
                type: "tool_start",
                toolName: block.name,
                toolUseId: block.id,
                summary: `${block.name}(${summarizeInput(asRecord(block.input))})`,
              };
            }
          }
        } else if (message.type === "user") {
          const user = message as ClaudeUserMessage;
          finalSessionId = user.session_id ?? finalSessionId;
          const content = user.message.content;
          if (!Array.isArray(content)) continue;

          for (const block of content) {
            if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
              continue;
            }
            const pending = openToolUses.get(block.tool_use_id);
            openToolUses.delete(block.tool_use_id);
            yield {
              type: "tool_end",
              toolUseId: block.tool_use_id,
              ok: !block.is_error,
              summary: summarizeToolResult(block.content),
            };
            void pending;
          }
        } else if (message.type === "result") {
          const result = message as ClaudeResultSuccess | ClaudeResultFailure;
          finalSessionId = result.session_id;
          if (result.subtype === "success") {
            const success = result as ClaudeResultSuccess;
            yield {
              type: "turn_complete",
              sessionId: finalSessionId,
              costUsd: success.total_cost_usd,
              durationMs: success.duration_ms,
              turns: success.num_turns,
            };
          } else {
            sawFatalError = true;
            yield {
              type: "error",
              message: `Claude Code turn ended without success (${result.subtype}).`,
              fatal: true,
            };
          }
        }
      }

      if (!sawFatalError) {
        // Defensive: if the stream ended without a result message (should not
        // happen, but subprocess crashes are possible), still terminate cleanly.
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function summarizeInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    const truncated = rendered.length > 60 ? rendered.slice(0, 57) + "..." : rendered;
    parts.push(`${key}=${truncated}`);
    if (parts.length >= 3) break;
  }
  return parts.join(", ");
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") {
    return content.length > 200 ? content.slice(0, 197) + "..." : content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join(" ")
      .trim();
    return text.length > 200 ? text.slice(0, 197) + "..." : text || "(no output)";
  }
  return "(no output)";
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
