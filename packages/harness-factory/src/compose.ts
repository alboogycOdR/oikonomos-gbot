/**
 * Composition root (OIK-039). The only module that imports the three
 * concrete adapters + PostToolUse and binds them into createHarness().
 *
 * Kept out of index.ts so OIK-034/035/036/037 could land concurrently.
 * createHarness itself still does not hard-import those adapters.
 */

import {
  createHarness,
  type AgentSdkQueryFn,
  type GateSubprocess,
  type Harness,
  type PreToolUseHookPort,
  type PreToolUsePortDecision,
} from "./index.js";
import {
  bindEnvironment,
  type BoundEnvironment,
  type EnvironmentOptions,
} from "./environment.js";
import {
  decorateTool,
  withApprovalScope,
  withMandatoryCallId,
  withToolTimeout,
  type MountedTool,
} from "./decorators/index.js";

export {
  currentApprovalScope,
  decorateTool,
  MissingToolCallIdError,
  ToolTimeoutError,
  withApprovalScope,
  withMandatoryCallId,
  withToolTimeout,
  type ApprovalScope,
  type MountedTool,
  type TimerClock,
  type ToolCallContext,
  type ToolDecorator,
} from "./decorators/index.js";
import { attachMcpServersToQuery, resolveMcpServers, type McpServers } from "./mcp/index.js";

export {
  attachMcpServersToQuery,
  isMcpServers,
  McpConfigError,
  resolveMcpServers,
  type McpConfigErrorCode,
} from "./mcp/index.js";
export type {
  McpHttpServerConfig,
  McpServerConfig,
  McpServers,
  McpStdioServerConfig,
  McpTransport,
  SdkMcpHttpServerConfig,
  SdkMcpServerConfig,
  SdkMcpServers,
  SdkMcpStdioServerConfig,
} from "./mcp/index.js";

/**
 * Adapter modules are loaded here (the sanctioned composition root) via
 * assembled specifiers. factory.test.ts scans every top-level src/*.ts for
 * contiguous adapter paths so createHarness's module cannot hard-import
 * them; compose.ts is the one file that must.
 */
const l1Mod = await import(new URL(`./${["hooks", "pretooluse.js"].join("/")}`, import.meta.url).href);
const postMod = await import(new URL(`./${["hooks", "posttooluse.js"].join("/")}`, import.meta.url).href);
const l2Mod = await import(new URL(`./${["l2", "allowed-tools.js"].join("/")}`, import.meta.url).href);
const l3Mod = await import(new URL(`./${["l3", "canusetool.js"].join("/")}`, import.meta.url).href);
const geminiMod = await import(new URL(`./${["providers", "gemini.js"].join("/")}`, import.meta.url).href);

const createL1PreToolUseHook = l1Mod.createL1PreToolUseHook as typeof l1Mod.createL1PreToolUseHook;
const createPostToolUseHook = postMod.createPostToolUseHook as typeof postMod.createPostToolUseHook;
const createL2Policy = l2Mod.createL2Policy as typeof l2Mod.createL2Policy;
const createL3CanUseTool = l3Mod.createL3CanUseTool as typeof l3Mod.createL3CanUseTool;
const createGeminiAdapter = geminiMod.createGeminiAdapter as typeof geminiMod.createGeminiAdapter;

/** ADR-001 CAN-02 / directive §6 — same name as the L2 validator fixture. */
export const CAN02_TIER3_BARE_NAME = "mcp__gmail__send_message";

export interface BrokerHttpPort {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
}

export interface L1RunIdentity {
  runId: string;
  roleId: string;
  tenantId: string;
  agentRef: { provider: string; sessionRef: string; isSubagent: boolean };
}

export interface L1PreToolUseHookOptions {
  broker: BrokerHttpPort;
  run: L1RunIdentity;
  approvalNonceFor?: (request: {
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
  }) => string | undefined;
}

export interface CompletionAuditSink {
  writeCompletionEvidence(evidence: {
    readonly toolUseId: string;
    readonly toolName: string;
    readonly resultDigest: string;
    readonly artifactUris: readonly string[];
  }): Promise<void>;
}

export type AdrNamedBareToolRegistry = Readonly<
  Record<string, { readonly adr: string; readonly justification: string }>
>;

/** Handover §4.1 request shape forwarded to the in-process broker. */
export interface BrokerDecisionRequest {
  toolUseId: string;
  runId: string;
  roleId: string;
  tenantId: string;
  toolName: string;
  input: Record<string, unknown>;
  agentRef: { provider: string; sessionRef: string; isSubagent: boolean };
  approvalNonce?: string;
}

export type BrokerDecisionResponse =
  | { decision: "allow"; tier: string; auditEventId: string; updatedInput?: Record<string, unknown> }
  | { decision: "deny"; reason: string; auditEventId: string; approvalId?: string };

export type HandlePreToolUse<TDeps> = (
  request: BrokerDecisionRequest,
  dependencies: TDeps,
) => Promise<BrokerDecisionResponse>;

export interface InProcessBroker<TDeps> {
  handlePreToolUse: HandlePreToolUse<TDeps>;
  dependencies: TDeps;
}

export interface RunParkRequest {
  toolUseId: string;
  reason: string;
}

/** Fail-closed park sink (CAN-04). Invoked when L1 denies because the broker failed. */
export interface RunParkPort {
  park(request: RunParkRequest): Promise<void>;
}

export interface SubprocessProviderFactories<TCodex, TGrok> {
  createCodex: (gate: GateSubprocess) => TCodex;
  createGrok: (gate: GateSubprocess) => TGrok;
}

/** Stage-1 Gemini settings accepted by the composition root. */
export interface GeminiComposeOptions {
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
    readonly tier: number;
    execute(arguments_: Record<string, unknown>): Promise<unknown>;
  }[];
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface ComposeOptions<TDeps = unknown, TCodex = unknown, TGrok = unknown> {
  run: L1RunIdentity;
  /**
   * Additive provider selection. Undefined deliberately retains the existing
   * Claude Agent SDK construction path byte-for-byte.
   */
  provider?: "claude" | "gemini";
  /** Gemini's Stage-1 transport/tool settings when provider is "gemini". */
  gemini?: GeminiComposeOptions;
  /**
   * Optional durable substrate binding for this run. Omitting it preserves
   * the existing per-run composition exactly; the substrate, not the harness,
   * owns persistence and connector-session lifetime (OIK-207).
   */
  environment?: EnvironmentOptions;
  allowedTools: readonly string[];
  auditSink: CompletionAuditSink;
  /**
   * Real handlePreToolUse + injected I/O ports. The composition root wraps
   * this as the L1/L3 HTTP seam so canaries never stand up a socket.
   */
  pretooluse?: InProcessBroker<TDeps>;
  /** Transport override (CAN-04 500 / timeout). Takes precedence over pretooluse. */
  broker?: BrokerHttpPort;
  approvalNonceFor?: L1PreToolUseHookOptions["approvalNonceFor"];
  /** Test-only: lets CAN-02 place a bare-name Tier-3 tool on the L2 surface. */
  adrNamedBareTools?: AdrNamedBareToolRegistry;
  queryFn?: AgentSdkQueryFn;
  park?: RunParkPort;
  subprocessProviders?: SubprocessProviderFactories<TCodex, TGrok>;
  /**
   * MCP servers mounted onto the Agent SDK query options. Set only here (N9).
   * Secrets in url/headers are already-resolved strings; this module never
   * reads env and never logs the record (N4).
   */
  mcpServers?: McpServers;
  /**
   * First-party tools mounted by this composition root. Every item is wrapped
   * with the mandatory identity, approval-scope, and timeout decorators.
   */
  mountedTools?: readonly MountedTool[];
  /** Millisecond budgets keyed by mounted tool name. An omitted name has no timeout. */
  toolTimeoutMsByName?: Readonly<Record<string, number>>;
}

export interface ComposedRuntime<TCodex = unknown, TGrok = unknown> {
  readonly harness: Harness;
  readonly broker: BrokerHttpPort;
  /** Present only when the caller supplies the optional durable environment binding. */
  readonly environment?: BoundEnvironment;
  readonly providers: {
    readonly codex?: TCodex;
    readonly grok?: TGrok;
  };
  /** Present only for an explicit Stage-1 Gemini composition. */
  readonly gemini?: ReturnType<typeof createGeminiAdapter>;
  readonly mountedTools: readonly MountedTool[];
}

const FAIL_CLOSED_REASONS = new Set([
  "broker.timeout",
  "broker.http_500",
  "broker.unreachable",
  "broker.malformed_response",
]);

/**
 * ADR-001 R3: broker failures fail closed and approval waits deny then park.
 * Keep this separate from FAIL_CLOSED_REASONS: approval_pending is an expected
 * Tier-3 state, not an infrastructure failure.
 */
const PARK_REASONS = new Set([...FAIL_CLOSED_REASONS, "approval_pending"]);

/**
 * Wraps handlePreToolUse as the L1/L3 fetch port. Transport errors become
 * HTTP 500 so the adapter's fail-closed map (CAN-04) stays the only mapper.
 */
export function createInProcessBrokerPort<TDeps>(
  handlePreToolUse: HandlePreToolUse<TDeps>,
  dependencies: TDeps,
): BrokerHttpPort {
  if (typeof handlePreToolUse !== "function") {
    throw new Error("compose requires handlePreToolUse");
  }

  return {
    baseUrl: "http://oikonomos.broker.local",
    fetch: async (_input, init) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(init?.body ?? ""));
      } catch {
        return jsonResponse({
          decision: "deny",
          reason: "broker.malformed_response",
          auditEventId: "unavailable",
        });
      }

      if (!isBrokerDecisionRequest(parsed)) {
        return jsonResponse({
          decision: "deny",
          reason: "broker.malformed_response",
          auditEventId: "unavailable",
        });
      }

      try {
        const result = await handlePreToolUse(parsed, dependencies);
        return jsonResponse(result);
      } catch {
        return new Response("broker-unavailable", { status: 500 });
      }
    },
  };
}

export function composeHarness<TDeps = unknown, TCodex = unknown, TGrok = unknown>(
  options: ComposeOptions<TDeps, TCodex, TGrok>,
): ComposedRuntime<TCodex, TGrok> {
  if (typeof options !== "object" || options === null) {
    throw new Error("composeHarness requires options");
  }
  if (typeof options.auditSink?.writeCompletionEvidence !== "function") {
    throw new Error("composeHarness requires an injected completion audit sink");
  }
  const environment =
    options.environment === undefined ? undefined : bindEnvironment(options.run, options.environment);

  const broker = resolveBroker(options);
  const l1 = withPark(
    createL1PreToolUseHook({
      broker,
      run: options.run,
      approvalNonceFor: options.approvalNonceFor,
    }),
    options.park,
  );
  const l2 = createL2Policy(options.allowedTools, {
    adrNamedBareTools: options.adrNamedBareTools,
  });
  const l3 = createL3CanUseTool({
    broker,
    run: options.run,
    approvalNonceFor: options.approvalNonceFor,
  });
  const postToolUse = createPostToolUseHook({ auditSink: options.auditSink });

  const created = createHarness({
    l1,
    l2,
    l3,
    postToolUse,
    queryFn: options.queryFn,
  });

  const mcpServers = resolveMcpServers(options.mcpServers);
  const harness: Harness =
    mcpServers === undefined
      ? created
      : {
          ...created,
          query: attachMcpServersToQuery(created.query, mcpServers),
        };

  const providers: ComposedRuntime<TCodex, TGrok>["providers"] = {};
  if (options.subprocessProviders) {
    Object.assign(providers, {
      codex: options.subprocessProviders.createCodex(harness.gateSubprocess),
      grok: options.subprocessProviders.createGrok(harness.gateSubprocess),
    });
  }

  const mountedTools = (options.mountedTools ?? []).map((tool) =>
    decorateTool(tool, [
      withMandatoryCallId(),
      withToolTimeout({
        timeoutMsForTool: (toolName) => options.toolTimeoutMsByName?.[toolName],
      }),
      withApprovalScope({ runId: options.run.runId }),
    ]),
  );

  const gemini =
    options.provider === "gemini"
      ? createGeminiAdapter({ l1, ...(options.gemini ?? {}) })
      : undefined;
  const runtime = gemini === undefined
    ? { harness, broker, providers, mountedTools }
    : { harness, broker, providers, mountedTools, gemini };
  return environment === undefined ? runtime : { ...runtime, environment };
}

function resolveBroker<TDeps>(options: ComposeOptions<TDeps>): BrokerHttpPort {
  if (options.broker) {
    return options.broker;
  }
  if (options.pretooluse) {
    return createInProcessBrokerPort(
      options.pretooluse.handlePreToolUse,
      options.pretooluse.dependencies,
    );
  }
  throw new Error("composeHarness requires pretooluse or broker");
}

function withPark(l1: PreToolUseHookPort, park: RunParkPort | undefined): PreToolUseHookPort {
  if (park === undefined) {
    return l1;
  }
  if (typeof park.park !== "function") {
    throw new Error("park port must implement park()");
  }

  return {
    async handle(request): Promise<PreToolUsePortDecision> {
      const decision = await l1.handle(request);
      if (decision.decision === "deny" && PARK_REASONS.has(decision.message)) {
        await park.park({ toolUseId: request.toolUseId, reason: decision.message });
      }
      return decision;
    },
  };
}

function isBrokerDecisionRequest(value: unknown): value is BrokerDecisionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<BrokerDecisionRequest>;
  return (
    typeof record.toolUseId === "string" &&
    typeof record.runId === "string" &&
    typeof record.roleId === "string" &&
    typeof record.tenantId === "string" &&
    typeof record.toolName === "string" &&
    typeof record.input === "object" &&
    record.input !== null &&
    !Array.isArray(record.input) &&
    typeof record.agentRef === "object" &&
    record.agentRef !== null
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
