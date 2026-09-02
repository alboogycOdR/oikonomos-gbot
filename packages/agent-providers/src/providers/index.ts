import type { AppConfig } from "../config.js";
import type { AgentProvider, ProviderId } from "../types.js";
import { ClaudeCodeProvider } from "./claudeCode.js";
import { CodexProvider } from "./codex.js";
import { GrokProvider } from "./grok.js";
import { GeminiProvider } from "./gemini.js";

/**
 * Builds one long-lived provider instance per backend, keyed by provider id.
 * Providers are stateless across chats (all per-conversation state lives in
 * SessionStore), so a single shared instance per provider is sufficient —
 * concurrent chats simply pass different `cwd`/`sessionId` into `sendPrompt`.
 *
 * ClaudeCodeProvider is constructed without an SDK query function. The
 * harness factory (OIK-033) injects that later; this package only constructs.
 */
export class ProviderRegistry {
  private readonly providers: Record<ProviderId, AgentProvider>;

  constructor(config: AppConfig) {
    this.providers = {
      "claude-code": new ClaudeCodeProvider({
        defaultModel: config.CLAUDE_MODEL,
        permissionMode: config.CLAUDE_PERMISSION_MODE,
      }),
      codex: new CodexProvider({
        bin: config.CODEX_BIN,
        defaultModel: config.CODEX_MODEL,
        sandbox: config.CODEX_SANDBOX,
        apiKey: config.CODEX_API_KEY,
      }),
      grok: new GrokProvider({
        bin: config.GROK_BIN,
        defaultModel: config.GROK_MODEL,
        sandbox: config.GROK_SANDBOX,
        alwaysApprove: config.GROK_ALWAYS_APPROVE,
        apiKey: config.XAI_API_KEY,
      }),
      gemini: new GeminiProvider({
        defaultModel: config.GEMINI_MODEL,
      }),
    };
  }

  get(id: ProviderId): AgentProvider {
    return this.providers[id];
  }

  all(): AgentProvider[] {
    return Object.values(this.providers);
  }
}

export { ClaudeCodeProvider } from "./claudeCode.js";
export type {
  ClaudeCodeProviderOptions,
  ClaudeQueryFn,
  ClaudeQueryMessage,
  ClaudeQueryOptions,
} from "./claudeCode.js";
export { CodexProvider, isCodexEvent, mapCodexEvent } from "./codex.js";
export type { CodexProviderOptions } from "./codex.js";
export { GrokProvider, buildGrokArgs } from "./grok.js";
export type { GrokProviderOptions, GrokSandboxProfile } from "./grok.js";
export { GeminiProvider } from "./gemini.js";
export type { GeminiProviderOptions, GeminiQueryFn, GeminiQueryResult, GeminiUsageMetadata } from "./gemini.js";
