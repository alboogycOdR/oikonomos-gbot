import type { BrokerDependencies } from "@oikonomos/broker";
import type { AgentSdkQueryFn, AgentSdkQueryInput } from "@oikonomos/harness-factory";
import type { CompletionAuditSink, L1RunIdentity } from "@oikonomos/harness-factory/compose";

export const WORKER_TOOL = "Read";
export const WORKER_TOOL_USE_ID = "worker-e4-liveness-1";
export const WORKER_CAPABILITY_ID = "fs.read";

export const workerRun: L1RunIdentity = {
  runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-worker", isSubagent: false },
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
  const options = input.options ?? {};
  const hooks = options.hooks as
    | { PreToolUse?: Array<{ hooks: Array<(...args: never[]) => Promise<unknown>> }> }
    | undefined;
  const hook = hooks?.PreToolUse?.[0]?.hooks[0];
  if (hook !== undefined) {
    await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: attempt.toolName,
        tool_use_id: attempt.toolUseId,
        tool_input: attempt.toolInput,
      } as never,
      attempt.toolUseId as never,
      { signal: new AbortController().signal } as never,
    );
  }

  const canUseTool = options.canUseTool as
    | ((
        toolName: string,
        toolInput: Record<string, unknown>,
        opts: { signal: AbortSignal; toolUseID: string; requestId: string },
      ) => Promise<unknown>)
    | undefined;
  if (typeof canUseTool === "function") {
    await canUseTool(attempt.toolName, attempt.toolInput, {
      signal: new AbortController().signal,
      toolUseID: attempt.toolUseId,
      requestId: `req-${attempt.toolUseId}`,
    });
  }

  yield { type: "result", toolUseId: attempt.toolUseId };
}
