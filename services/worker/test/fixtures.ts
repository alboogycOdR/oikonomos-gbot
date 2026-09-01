import type { BrokerDependencies } from "@oikonomos/broker";
import type { AgentSdkQueryFn, AgentSdkQueryInput } from "@oikonomos/harness-factory";
import type { CompletionAuditSink, L1RunIdentity } from "@oikonomos/harness-factory/compose";

import type { ConnectorContext } from "../src/executeRun.js";

export const WORKER_TOOL = "Read";
export const WORKER_TOOL_USE_ID = "worker-e4-liveness-1";
export const WORKER_CAPABILITY_ID = "fs.read";

export const GMAIL_SERVER = "gmail";
export const GMAIL_LIST_TOOL = "mcp__gmail__list_messages";
export const GMAIL_DRAFT_TOOL = "mcp__gmail__create_draft";
export const GMAIL_SEND_TOOL = "mcp__gmail__send_message";
export const FAKE_GMAIL_MCP_URL = "http://oikonomos.mcp.fake.local/gmail";

export const workerRun: L1RunIdentity = {
  runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-worker", isSubagent: false },
};

export const triageRun: L1RunIdentity = {
  runId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-inbox-triage", isSubagent: false },
};

export interface DecisionLog {
  readonly events: Parameters<BrokerDependencies["recordDecision"]>[0][];
  recordDecision: BrokerDependencies["recordDecision"];
}

export function createDecisionLog(): DecisionLog {
  const events: DecisionLog["events"] = [];
  return {
    events,
    recordDecision: async (event) => {
      events.push(event);
      return { eventId: `evt-${String(events.length)}` };
    },
  };
}

export function createCompletionSink(): CompletionAuditSink {
  return {
    async writeCompletionEvidence() {
      return;
    },
  };
}

export interface RecordingCompletionSink {
  readonly writes: Array<{
    readonly toolUseId: string;
    readonly toolName: string;
    readonly resultDigest: string;
    readonly artifactUris: readonly string[];
  }>;
  readonly sink: CompletionAuditSink;
}

export function createRecordingCompletionSink(): RecordingCompletionSink {
  const writes: RecordingCompletionSink["writes"] = [];
  return {
    writes,
    sink: {
      async writeCompletionEvidence(evidence) {
        writes.push(evidence);
      },
    },
  };
}

export function createWorkerBrokerDeps(audit: DecisionLog): BrokerDependencies {
  return {
    isCapabilitiesEnabled: () => true,
    getCapability: async (toolName) =>
      toolName === WORKER_TOOL
        ? { toolName: WORKER_TOOL, capabilityId: WORKER_CAPABILITY_ID, defaultTier: "T0_observe" }
        : null,
    getRoleGrant: async () => ({ maxTier: "T0_observe" }),
    destinationFor: () => "n/a",
    issueApproval: async () => {
      throw new Error("T0 worker fixture must not issue an approval");
    },
    verifyAndConsume: async () => {
      throw new Error("T0 worker fixture must not consume an approval");
    },
    issueApprovalDependencies: { store: null as never },
    consumeDependencies: { store: null as never },
    recordDecision: audit.recordDecision,
  };
}

const GMAIL_CATALOG: Readonly<
  Record<string, { capabilityId: string; defaultTier: "T0_observe" | "T1_draft" | "T3_external" }>
> = {
  [GMAIL_LIST_TOOL]: { capabilityId: "email.list", defaultTier: "T0_observe" },
  [GMAIL_DRAFT_TOOL]: { capabilityId: "email.create_draft", defaultTier: "T1_draft" },
  [GMAIL_SEND_TOOL]: { capabilityId: "email.send", defaultTier: "T3_external" },
};

/**
 * Inbox-triage broker ports: list + draft are granted at max T1_draft;
 * send is registered at T3 so L1 denies it as `role.tier_ceiling` (the
 * G-CONN closed-send shape) and still writes an audit event.
 */
export function createGmailBrokerDeps(audit: DecisionLog): BrokerDependencies {
  return {
    isCapabilitiesEnabled: () => true,
    getCapability: async (toolName) => {
      const entry = GMAIL_CATALOG[toolName];
      if (entry === undefined) {
        return null;
      }
      return { toolName, capabilityId: entry.capabilityId, defaultTier: entry.defaultTier };
    },
    getRoleGrant: async () => ({ maxTier: "T1_draft" }),
    destinationFor: () => "review@example.test",
    issueApproval: async () => {
      throw new Error("inbox-triage fixture must not issue an approval for T0/T1");
    },
    verifyAndConsume: async () => {
      throw new Error("inbox-triage fixture must not consume an approval");
    },
    issueApprovalDependencies: { store: null as never },
    consumeDependencies: { store: null as never },
    recordDecision: audit.recordDecision,
  };
}

export const gmailManifestSlice = {
  connector_id: "gmail",
  mcp_server: { name: GMAIL_SERVER },
  tools: [
    {
      tool_name: GMAIL_LIST_TOOL,
      capability_id: "email.list",
      default_tier: "T0_observe",
    },
    {
      tool_name: GMAIL_DRAFT_TOOL,
      capability_id: "email.create_draft",
      default_tier: "T1_draft",
    },
    {
      tool_name: GMAIL_SEND_TOOL,
      capability_id: "email.send",
      default_tier: "T3_external",
      enabled: false,
    },
  ],
} as const;

export const gmailDerivedAllowedTools: readonly string[] = [GMAIL_LIST_TOOL, GMAIL_DRAFT_TOOL];

export function gmailConnectorContext(
  overrides: Partial<ConnectorContext> = {},
): ConnectorContext {
  return {
    manifest: gmailManifestSlice,
    mcpServers: {
      [GMAIL_SERVER]: { transport: "http", url: FAKE_GMAIL_MCP_URL },
    },
    allowedTools: [...gmailDerivedAllowedTools],
    ...overrides,
  };
}

export interface FakeMcpTransport {
  readonly invocations: Array<{ tool: string; input: Record<string, unknown> }>;
  invoke(tool: string, input: Record<string, unknown>): Promise<unknown>;
}

export function createFakeGmailMcp(): FakeMcpTransport {
  const invocations: FakeMcpTransport["invocations"] = [];
  return {
    invocations,
    async invoke(tool, input) {
      invocations.push({ tool, input });
      if (tool === "list_messages") {
        return { messages: [{ id: "m1", snippet: "please review the invoice" }] };
      }
      if (tool === "create_draft") {
        return { draftId: "d1", status: "created" };
      }
      return { ok: true, tool };
    },
  };
}

/**
 * Stands in for the Agent SDK: when the composed harness injects L1/L3
 * onto `options`, a tool attempt is presented to those ports. A caller
 * that invokes this function without composeHarness never reaches the
 * broker, so no audit event is written.
 */
export function simulatingWorkerQuery(input: AgentSdkQueryInput): AsyncIterable<unknown> {
  return simulateWorkerToolAttempt(input, {
    toolName: WORKER_TOOL,
    toolUseId: WORKER_TOOL_USE_ID,
    toolInput: { path: "src/index.ts" },
  });
}

export const workerQueryFn: AgentSdkQueryFn = simulatingWorkerQuery;

export async function* simulateWorkerToolAttempt(
  input: AgentSdkQueryInput,
  attempt: { toolName: string; toolUseId: string; toolInput: Record<string, unknown> },
): AsyncGenerator<unknown> {
  await presentToolAttempt(input, attempt);
  yield { type: "result", toolUseId: attempt.toolUseId };
}

export interface ToolAttemptOutcome {
  readonly allowed: boolean;
  readonly reason: string | undefined;
}

export async function presentToolAttempt(
  input: AgentSdkQueryInput,
  attempt: { toolName: string; toolUseId: string; toolInput: Record<string, unknown> },
): Promise<ToolAttemptOutcome> {
  const options = input.options ?? {};
  const hooks = options.hooks as
    | { PreToolUse?: Array<{ hooks: Array<(...args: never[]) => Promise<unknown>> }> }
    | undefined;
  const hook = hooks?.PreToolUse?.[0]?.hooks[0];
  let allowed = true;
  let reason: string | undefined;
  if (hook !== undefined) {
    const output = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: attempt.toolName,
        tool_use_id: attempt.toolUseId,
        tool_input: attempt.toolInput,
      } as never,
      attempt.toolUseId as never,
      { signal: new AbortController().signal } as never,
    );
    const decision = (
      output as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
    ).hookSpecificOutput;
    if (decision?.permissionDecision === "deny") {
      allowed = false;
      reason = decision.permissionDecisionReason;
    }
  }

  const canUseTool = options.canUseTool as
    | ((
        toolName: string,
        toolInput: Record<string, unknown>,
        opts: { signal: AbortSignal; toolUseID: string; requestId: string },
      ) => Promise<{ behavior?: string; message?: string }>)
    | undefined;
  if (typeof canUseTool === "function") {
    const l3 = await canUseTool(attempt.toolName, attempt.toolInput, {
      signal: new AbortController().signal,
      toolUseID: attempt.toolUseId,
      requestId: `req-${attempt.toolUseId}`,
    });
    if (l3?.behavior === "deny") {
      allowed = false;
      reason = reason ?? l3.message;
    }
  }

  return { allowed, reason };
}

export async function presentPostToolUse(
  input: AgentSdkQueryInput,
  attempt: { toolName: string; toolUseId: string; toolInput: Record<string, unknown> },
  toolResponse: unknown,
): Promise<void> {
  const options = input.options ?? {};
  const hooks = options.hooks as
    | { PostToolUse?: Array<{ hooks: Array<(...args: never[]) => Promise<unknown>> }> }
    | undefined;
  const hook = hooks?.PostToolUse?.[0]?.hooks[0];
  if (hook === undefined) {
    return;
  }
  await hook(
    {
      hook_event_name: "PostToolUse",
      tool_name: attempt.toolName,
      tool_use_id: attempt.toolUseId,
      tool_input: attempt.toolInput,
      tool_response: toolResponse,
    } as never,
    attempt.toolUseId as never,
    { signal: new AbortController().signal } as never,
  );
}

export interface InboxTriageQueryCapture {
  mcpServers?: unknown;
}

const TRIAGE_ATTEMPTS = [
  {
    toolName: GMAIL_LIST_TOOL,
    toolUseId: "triage-list-1",
    toolInput: { q: "in:inbox", max: 5 },
    mcpTool: "list_messages",
  },
  {
    toolName: GMAIL_DRAFT_TOOL,
    toolUseId: "triage-draft-1",
    toolInput: { to: "review@example.test", body: "draft reply" },
    mcpTool: "create_draft",
  },
  {
    toolName: GMAIL_SEND_TOOL,
    toolUseId: "triage-send-1",
    toolInput: { to: "review@example.test", body: "send this" },
    mcpTool: "send_message",
  },
] as const;

/**
 * Fake Agent SDK queryFn: one inbox-triage turn that lists, drafts, then
 * attempts send. MCP transport is invoked only when L1/L3 allow.
 */
export function createInboxTriageQueryFn(args: {
  fake: FakeMcpTransport;
  capture?: InboxTriageQueryCapture;
}): AgentSdkQueryFn {
  return async function* (input: AgentSdkQueryInput) {
    if (args.capture !== undefined) {
      const options = input.options as { mcpServers?: unknown } | undefined;
      args.capture.mcpServers = options?.mcpServers;
    }
    for (const attempt of TRIAGE_ATTEMPTS) {
      const outcome = await presentToolAttempt(input, attempt);
      if (outcome.allowed) {
        const result = await args.fake.invoke(attempt.mcpTool, attempt.toolInput);
        await presentPostToolUse(input, attempt, result);
        yield {
          type: "tool_result",
          toolUseId: attempt.toolUseId,
          toolName: attempt.toolName,
          executed: true,
          result,
        };
      } else {
        yield {
          type: "tool_denied",
          toolUseId: attempt.toolUseId,
          toolName: attempt.toolName,
          executed: false,
          reason: outcome.reason,
        };
      }
    }
  };
}

export function simulatingMcpQuery(input: AgentSdkQueryInput): AsyncIterable<unknown> {
  const fake = createFakeGmailMcp();
  return createInboxTriageQueryFn({ fake })(input);
}
