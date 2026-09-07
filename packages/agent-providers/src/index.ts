export {
  isProviderId,
  PROVIDER_IDS,
  type AgentProvider,
  type AgentSession,
  type ChatState,
  type ErrorEvent,
  type FileWrittenEvent,
  type PermissionDecision,
  type PermissionRequestEvent,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderId,
  type SendPromptOptions,
  type TextDeltaEvent,
  type ThinkingDeltaEvent,
  type ToolEndEvent,
  type ToolStartEvent,
  type TurnCompleteEvent,
} from "./types.js";

export {
  ConfigError,
  loadConfig,
  loadConfigFromEnv,
  type AppConfig,
  type ClaudePermissionMode,
  type CodexSandbox,
  type Env,
  type GrokSandbox,
  type LogLevel,
} from "./config.js";

export { AccessGuard, type UnauthorizedAttempt } from "./security.js";

export {
  buildGrokArgs,
  ClaudeCodeProvider,
  CodexProvider,
  FreeLlmApiProvider,
  // GeminiProvider was implemented but never re-exported here, so it was
  // unreachable from this package's only entry point ("." -> dist/index.js)
  // and no production caller could construct one.
  GeminiProvider,
  GrokProvider,
  isCodexEvent,
  mapCodexEvent,
  ProviderRegistry,
  type ClaudeCodeProviderOptions,
  type ClaudeQueryFn,
  type ClaudeQueryMessage,
  type ClaudeQueryOptions,
  type CodexProviderOptions,
  type FreeLlmApiFetch,
  type FreeLlmApiProviderOptions,
  type FreeLlmApiUsageTokens,
  type GeminiProviderOptions,
  type GeminiQueryFn,
  type GeminiQueryResult,
  type GeminiUsageMetadata,
  type GrokProviderOptions,
  type GrokSandboxProfile,
} from "./providers/index.js";

/**
 * The Gemini price table. Exported so a caller configuring a Gemini-backed
 * endpoint can price its own turns (see `FreeLlmApiProviderOptions.costFromUsage`)
 * instead of every call recording $0.00.
 */
export {
  costForUsage,
  GEMINI_3_7_FLASH_INPUT_USD_PER_MILLION_TOKENS,
  GEMINI_3_7_FLASH_OUTPUT_USD_PER_MILLION_TOKENS,
  type UsageTokens,
} from "./pricing.js";

export {
  BudgetSinkError,
  withBudgetSink,
  type BudgetReport,
  type BudgetSink,
} from "./budget.js";

export {
  IncompleteProviderError,
  ValidatingProviderRegistry,
  assertProviderComplete,
  type CandidateProvider,
} from "./registration.js";

export {
  extrasFor,
  withProviderExtras,
  type ClaudeCodeProviderExtras,
  type CodexProviderExtras,
  type GrokProviderExtras,
  type FreeLlmApiProviderExtras,
  type NamespacedProviderExtras,
  type ProviderExtrasMap,
} from "./metadata.js";
