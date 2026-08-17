/**
 * DI seams for the three ADR-001 layers plus the subprocess spawn gate.
 *
 * Concrete adapters (OIK-034/035/036/037) implement these interfaces.
 * `createHarness` must not hard-import those adapters — composition is OIK-039.
 */

import type { L2Policy } from "./config.js";

export interface PreToolUsePortRequest {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export type PreToolUsePortDecision =
  | { decision: "allow"; updatedInput?: Record<string, unknown> }
  | { decision: "deny"; message: string };

/** L1 — primary enforcement. Every tool call (and gated spawn) goes through this. */
export interface PreToolUseHookPort {
  handle(request: PreToolUsePortRequest): Promise<PreToolUsePortDecision>;
}

export interface CanUseToolPortRequest {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export type CanUseToolPortDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** L3 — secondary runtime. Never the sole enforcement. Idempotent with L1 per toolUseId. */
export interface CanUseToolPort {
  canUseTool(request: CanUseToolPortRequest): Promise<CanUseToolPortDecision>;
}

/** L2 is typed data (see config.ts), injected as a port value. */
export type L2PolicyPort = L2Policy;

export interface PostToolUsePortRequest {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  toolResponse: unknown;
}

/**
 * Optional R4 completion hook. Implemented by OIK-037; declared here so the
 * factory can attach it without importing that adapter.
 */
export interface PostToolUseHookPort {
  handle(request: PostToolUsePortRequest): Promise<void>;
}

export type SubprocessProvider = "codex" | "grok";

/**
 * Codex and Grok providers spawn their CLIs directly (TASK-028 review).
 * The factory gates that spawn through L1 so it cannot bypass the broker.
 */
export interface SubprocessSpawnRequest {
  provider: SubprocessProvider;
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export type SubprocessGateResult =
  | { allow: true; request: SubprocessSpawnRequest }
  | { allow: false; message: string };

export type GateSubprocess = (request: SubprocessSpawnRequest) => Promise<SubprocessGateResult>;

export interface AgentSdkQueryInput {
  prompt: string | AsyncIterable<unknown>;
  options?: Record<string, unknown>;
}

export type AgentSdkQueryFn = (input: AgentSdkQueryInput) => AsyncIterable<unknown>;

export interface SdkHookCallbackOptions {
  signal: AbortSignal;
}

export type SdkHookCallback = (
  input: Record<string, unknown>,
  toolUseID: string | undefined,
  options: SdkHookCallbackOptions,
) => Promise<Record<string, unknown>>;

export interface SdkHookMatcher {
  matcher?: string;
  hooks: SdkHookCallback[];
  timeout?: number;
}

export type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    toolUseID: string;
    requestId: string;
    agentID?: string;
  },
) => Promise<CanUseToolPortDecision>;

export interface HarnessInvocation {
  permissionMode: L2Policy["permissionMode"];
  allowedTools: string[];
  hooks: {
    PreToolUse: SdkHookMatcher[];
    PostToolUse?: SdkHookMatcher[];
    [event: string]: SdkHookMatcher[] | undefined;
  };
  canUseTool: SdkCanUseTool;
}

export interface HarnessDeps {
  l1: PreToolUseHookPort;
  l2: L2PolicyPort;
  l3: CanUseToolPort;
  /** Optional R4 port; composition root supplies the OIK-037 adapter. */
  postToolUse?: PostToolUseHookPort;
  /**
   * Injected Agent SDK `query`. Defaults to the package dependency.
   * Tests and the composition root may override.
   */
  queryFn?: AgentSdkQueryFn;
}

export interface Harness {
  query: AgentSdkQueryFn;
  config: L2Policy;
  invocation: HarnessInvocation;
  gateSubprocess: GateSubprocess;
}
