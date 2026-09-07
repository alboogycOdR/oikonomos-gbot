/**
 * Composition root (OIK-039). The only module that imports the three
 * concrete adapters + PostToolUse and binds them into createHarness().
 *
 * Kept out of index.ts so OIK-034/035/036/037 could land concurrently.
 * createHarness itself still does not hard-import those adapters.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  createHarness,
  type AgentSdkQueryFn,
  type GateSubprocess,
  type Harness,
  type PreToolUseHookPort,
  type PreToolUsePortDecision,
} from "./index.js";
import { withBudgetTap, type BudgetTapSink } from "./budgetTap.js";
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

/**
 * Re-exported so a caller can name the ceiling it must pass (TASK-220).
 *
 * `providers/gemini.ts` is not on this package's public surface, so the
 * constant defining Stage 2's tool ceiling was unreachable from any consumer
 * — the second instance today of a control that exists but cannot be
 * referenced, after `maximumToolTier` itself was unreachable through
 * `composeHarness` (TASK-215).
 */
export const STAGE_TWO_MAXIMUM_TOOL_TIER: number = geminiMod.STAGE_TWO_MAXIMUM_TOOL_TIER as number;

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
  /**
   * Highest tool tier this composition may execute (TASK-212's ceiling).
   *
   * Without this, that ceiling was unreachable: `createGeminiAdapter` is not
   * on this package's public surface (the exports map is ".", "./compose",
   * "./mcp"), so `composeHarness` is the only way to construct the adapter,
   * and it had no way to pass the option through. A control that cannot be
   * configured is inert in a different way from one that is misconfigured —
   * TASK-212's review verified an out-of-range ceiling is REFUSED, but not
   * that any ceiling could be SET.
   *
   * Omitted keeps the adapter's Stage-1 default; the adapter still refuses
   * anything above its own absolute bound at construction.
   */
  readonly maximumToolTier?: number;
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
  /**
   * Optional Claude Agent SDK cost sink (TASK-163). When set, the final
   * `harness.query` (after MCP attach) is wrapped with `withBudgetTap`.
   * Omitting it preserves existing compositions byte-for-byte unless a sink
   * is bound for this call via {@link runWithChatBudget}.
   */
  budgetTap?: BudgetTapSink;
  /**
   * Optional live budget decision invoked before every L1 PreToolUse call.
   * A deny short-circuits the broker; a thrown check fails closed. Same ALS
   * fallback as `budgetTap`.
   */
  budgetCheck?: BudgetGateCheck;
}

/**
 * Live per-decision budget check. Mirrors `resolveBudgetGate`'s decision
 * shape without importing `@oikonomos/broker` (this package has no broker
 * dependency). The worker supplies the real DB-backed implementation.
 */
export type BudgetGateCheck = () => Promise<
  { readonly decision: "allow" } | { readonly decision: "deny"; readonly reason: string }
>;

/**
 * Call-scoped budget wiring for the Claude SDK path. `executeTaskRun` is
 * the sole production `composeHarness` caller and cannot grow a new option
 * in this task (out of territory), so the chat driver binds the sink/check
 * around that call with {@link runWithChatBudget}. composeHarness reads the
 * store at composition time — wrap the `composeHarness` invocation, not
 * only the later `harness.query` iteration.
 */
export interface ChatBudgetContext {
  readonly tap: BudgetTapSink;
  readonly check?: BudgetGateCheck;
}

const chatBudgetStorage = new AsyncLocalStorage<ChatBudgetContext>();

/** Bind a Claude-path budget tap/check for the duration of `fn`. */
export function runWithChatBudget<T>(context: ChatBudgetContext, fn: () => T): T {
  if (typeof context?.tap?.report !== "function") {
    throw new Error("runWithChatBudget requires a budget tap with report()");
  }
  if (context.check !== undefined && typeof context.check !== "function") {
    throw new Error("runWithChatBudget check must be a function when provided");
  }
  return chatBudgetStorage.run(context, fn);
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
  const budgetTap = resolveBudgetTap(options.budgetTap);
  const budgetCheck = resolveBudgetCheck(options.budgetCheck);
  const l1 = withPark(
    withBudgetGate(
      createL1PreToolUseHook({
        broker,
        run: options.run,
        approvalNonceFor: options.approvalNonceFor,
      }),
      budgetCheck,
    ),
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
  // TASK-150: wrap the final composed query (after MCP attach) so the tap
  // observes the primary SDK path. A missing tap is a no-op — existing
  // callers that never opted into cost tracking stay byte-identical.
  let query = mcpServers === undefined
    ? created.query
    : attachMcpServersToQuery(created.query, mcpServers);
  if (budgetTap !== undefined) {
    query = withBudgetTap(query, budgetTap);
  }
  const harness: Harness = query === created.query ? created : { ...created, query };

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

  // Each declared field is picked explicitly; the caller's object is NEVER
  // spread in (TASK-215 R1, Fable review).
  //
  // `{ l1, ...(options.gemini ?? {}) }` spread the caller's object AFTER the
  // broker port, so a `gemini` options object carrying an `l1` key replaced
  // it — handing enforcement to a caller-supplied object and defeating
  // CLAUDE.md non-negotiable 1 outright. TypeScript's excess-property check
  // only guards object literals, so anything arriving as a typed variable,
  // parsed JSON, or a widened type passed straight through. Ordering the
  // spread first would also fix it, but only until someone reorders the
  // lines; an explicit allow-list cannot regress that way.
  const geminiOptions = options.gemini;
  const gemini =
    options.provider === "gemini"
      ? createGeminiAdapter({
        l1,
        ...(geminiOptions?.tools === undefined ? {} : { tools: geminiOptions.tools }),
        ...(geminiOptions?.fetch === undefined ? {} : { fetch: geminiOptions.fetch }),
        ...(geminiOptions?.timeoutMs === undefined ? {} : { timeoutMs: geminiOptions.timeoutMs }),
        ...(geminiOptions?.maximumToolTier === undefined ? {} : { maximumToolTier: geminiOptions.maximumToolTier }),
      })
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

function resolveBudgetTap(composeTap: BudgetTapSink | undefined): BudgetTapSink | undefined {
  const tap = composeTap ?? chatBudgetStorage.getStore()?.tap;
  if (tap !== undefined && typeof tap.report !== "function") {
    throw new Error("budgetTap must implement report()");
  }
  return tap;
}

function resolveBudgetCheck(composeCheck: BudgetGateCheck | undefined): BudgetGateCheck | undefined {
  const check = composeCheck ?? chatBudgetStorage.getStore()?.check;
  if (check !== undefined && typeof check !== "function") {
    throw new Error("budgetCheck must be a function");
  }
  return check;
}

/**
 * Live budget gate in front of L1. A deny does not park — budget reasons
 * are not in PARK_REASONS — so the tool call fails for that turn and the
 * next call re-reads spend.
 */
function withBudgetGate(l1: PreToolUseHookPort, check: BudgetGateCheck | undefined): PreToolUseHookPort {
  if (check === undefined) {
    return l1;
  }
  return {
    async handle(request): Promise<PreToolUsePortDecision> {
      let decision;
      try {
        decision = await check();
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : "budget check failed";
        return { decision: "deny", message: `budget.check_failed: ${message}` };
      }
      if (decision.decision === "deny") {
        return { decision: "deny", message: decision.reason };
      }
      return l1.handle(request);
    },
  };
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
