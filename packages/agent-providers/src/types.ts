/**
 * Shared types for interchangeable agent backends.
 *
 * Three providers turn a text prompt into a coding-agent (or chat) response:
 *
 *   - claude-code : full agentic coding via an injected Claude Agent SDK query
 *   - codex       : full agentic coding via the OpenAI `codex` CLI (subprocess)
 *   - grok        : full agentic coding via xAI's `grok` CLI (subprocess)
 *
 * Every provider emits the same ProviderEvent stream so callers only have to
 * know one protocol.
 */

export type ProviderId = "claude-code" | "codex" | "grok";

export const PROVIDER_IDS: readonly ProviderId[] = ["claude-code", "codex", "grok"];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Capability flags a provider advertises so the caller can adapt its UI. */
export interface ProviderCapabilities {
  /** Can read/write files and run shell commands in a working directory. */
  agentic: boolean;
  /** Supports resuming a prior conversation by session id. */
  resumableSessions: boolean;
  /** Emits permission requests that need user approval (approve/deny). */
  permissionPrompts: boolean;
  /** Supports being interrupted mid-turn. */
  interruptible: boolean;
}

/**
 * A single logical conversation tracked for one chat.
 * Each provider keeps its own notion of "session id" (Claude Agent SDK
 * session UUID, Codex thread id, or Grok Build session id) but
 * the caller only needs to persist this envelope.
 */
export interface AgentSession {
  provider: ProviderId;
  /** Provider-native session/thread identifier, if the provider is resumable. */
  sessionId: string | null;
  /** Absolute path to the working directory this session operates in. */
  cwd: string;
  /** Model override, if the user picked one. */
  model: string | null;
  /** Unix ms timestamp of the last activity, used for idle bookkeeping. */
  lastActiveAt: number;
  /** Human-friendly title, shown in /status. */
  title: string | null;
}

/** Per-chat bot state persisted to disk between restarts. */
export interface ChatState {
  chatId: number;
  activeProvider: ProviderId;
  sessions: Partial<Record<ProviderId, AgentSession>>;
}

// ---------------------------------------------------------------------------
// Provider event stream
// ---------------------------------------------------------------------------

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  text: string;
}

export interface ToolStartEvent {
  type: "tool_start";
  toolName: string;
  /** Short human-readable summary of the tool call, e.g. "bash: npm test". */
  summary: string;
  toolUseId: string;
}

export interface ToolEndEvent {
  type: "tool_end";
  toolUseId: string;
  ok: boolean;
  /** Short summary of the result, truncated for chat display. */
  summary: string;
}

export interface PermissionRequestEvent {
  type: "permission_request";
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface FileWrittenEvent {
  type: "file_written";
  path: string;
  /** Absolute path on disk where the caller can read the file to relay it. */
  absolutePath: string;
  action: "write" | "edit";
}

export interface ErrorEvent {
  type: "error";
  message: string;
  fatal: boolean;
}

export interface TurnCompleteEvent {
  type: "turn_complete";
  /** Provider-native session id after this turn (may be new on first turn). */
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
}

export type ProviderEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolStartEvent
  | ToolEndEvent
  | PermissionRequestEvent
  | FileWrittenEvent
  | ErrorEvent
  | TurnCompleteEvent;

/** Caller-supplied decision for a pending PermissionRequestEvent. */
export type PermissionDecision =
  | { allow: true; remember?: boolean }
  | { allow: false; reason?: string };

export interface SendPromptOptions {
  prompt: string;
  cwd: string;
  sessionId: string | null;
  model: string | null;
  /** Called by the provider when it needs a permission decision. Must resolve. */
  onPermissionRequest?: (event: PermissionRequestEvent) => Promise<PermissionDecision>;
  signal: AbortSignal;
}

/** Common interface every provider adapter implements. */
export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  readonly defaultModel: string;
  readonly availableModels: readonly string[];

  /**
   * Send a prompt and stream back events until the turn completes or errors.
   * Implementations MUST always terminate the stream with either a
   * `turn_complete` or a fatal `error` event.
   */
  sendPrompt(options: SendPromptOptions): AsyncGenerator<ProviderEvent, void, unknown>;

  /** Best-effort abort of an in-flight turn for this provider instance. */
  interrupt(): Promise<void>;
}
