import { handlePreToolUse, type BrokerDependencies } from "@oikonomos/broker";
import type { AgentSdkQueryFn } from "@oikonomos/harness-factory";
import {
  composeHarness,
  type CompletionAuditSink,
  type ComposedRuntime,
  type L1RunIdentity,
  type RunParkPort,
  type SubprocessProviderFactories,
} from "@oikonomos/harness-factory/compose";

/**
 * Production agent-invocation path (OIK-041 HIGH-2).
 *
 * Every worker-driven model call goes through `composeHarness` so L1/L2/L3
 * and PostToolUse are bound before `harness.query` runs. There is no
 * second construction path and no direct Agent SDK import (N9).
 */

export class WorkerExecutionError extends Error {
  readonly code: string;

  constructor(message: string, code = "WORKER_EXECUTE") {
    super(message);
    this.name = "WorkerExecutionError";
    this.code = code;
  }
}

export interface ExecuteTaskRunInput<TCodex = unknown, TGrok = unknown> {
  prompt: string;
  run: L1RunIdentity;
  allowedTools: readonly string[];
  brokerDependencies: BrokerDependencies;
  auditSink: CompletionAuditSink;
  park?: RunParkPort;
  queryFn?: AgentSdkQueryFn;
  subprocessProviders?: SubprocessProviderFactories<TCodex, TGrok>;
  approvalNonceFor?: (request: {
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
  }) => string | undefined;
}

export interface ExecuteTaskRunResult<TCodex = unknown, TGrok = unknown> {
  readonly events: readonly unknown[];
  readonly runtime: ComposedRuntime<TCodex, TGrok>;
}

export async function executeTaskRun<TCodex = unknown, TGrok = unknown>(
  input: ExecuteTaskRunInput<TCodex, TGrok>,
): Promise<ExecuteTaskRunResult<TCodex, TGrok>> {
  assertExecuteInput(input);

  const runtime = composeHarness<BrokerDependencies, TCodex, TGrok>({
    run: input.run,
    allowedTools: input.allowedTools,
    auditSink: input.auditSink,
    park: input.park,
    queryFn: input.queryFn,
    subprocessProviders: input.subprocessProviders,
    approvalNonceFor: input.approvalNonceFor,
    pretooluse: {
      handlePreToolUse,
      dependencies: input.brokerDependencies,
    },
  });

  const events: unknown[] = [];
  for await (const event of runtime.harness.query({ prompt: input.prompt })) {
    events.push(event);
  }

  return { events, runtime };
}

function assertExecuteInput<TCodex, TGrok>(
  input: ExecuteTaskRunInput<TCodex, TGrok>,
): void {
  if (typeof input !== "object" || input === null) {
    throw new WorkerExecutionError("executeTaskRun requires an input object", "INVALID_INPUT");
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new WorkerExecutionError("executeTaskRun requires a non-empty prompt", "INVALID_PROMPT");
  }
  if (!isRunIdentity(input.run)) {
    throw new WorkerExecutionError("executeTaskRun requires a complete run identity", "INVALID_RUN");
  }
  if (!Array.isArray(input.allowedTools) || input.allowedTools.length === 0) {
    throw new WorkerExecutionError("executeTaskRun requires a non-empty allowedTools list", "INVALID_TOOLS");
  }
  if (typeof input.brokerDependencies !== "object" || input.brokerDependencies === null) {
    throw new WorkerExecutionError(
      "executeTaskRun requires broker dependencies",
      "INVALID_BROKER_DEPS",
    );
  }
  if (typeof input.auditSink?.writeCompletionEvidence !== "function") {
    throw new WorkerExecutionError(
      "executeTaskRun requires an injected completion audit sink",
      "INVALID_AUDIT_SINK",
    );
  }
  if (input.park !== undefined && typeof input.park.park !== "function") {
    throw new WorkerExecutionError("park port must implement park()", "INVALID_PARK");
  }
  if (input.queryFn !== undefined && typeof input.queryFn !== "function") {
    throw new WorkerExecutionError("queryFn must be a function when provided", "INVALID_QUERY");
  }
}

function isRunIdentity(value: unknown): value is L1RunIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const run = value as Partial<L1RunIdentity>;
  return (
    isNonEmptyString(run.runId) &&
    isNonEmptyString(run.roleId) &&
    isNonEmptyString(run.tenantId) &&
    typeof run.agentRef === "object" &&
    run.agentRef !== null &&
    isNonEmptyString(run.agentRef.provider) &&
    isNonEmptyString(run.agentRef.sessionRef) &&
    typeof run.agentRef.isSubagent === "boolean"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/worker executeTaskRun — input validation (no broker required)", () => {
    it("rejects a missing prompt and an incomplete run identity", async () => {
      const auditSink = { writeCompletionEvidence: async () => undefined };
      await expect(
        executeTaskRun({
          prompt: "   ",
          run: {
            runId: "run-1",
            roleId: "inbox-triage",
            tenantId: "basileia",
            agentRef: { provider: "claude", sessionRef: "sess", isSubagent: false },
          },
          allowedTools: ["Read(src/**)"],
          brokerDependencies: {} as BrokerDependencies,
          auditSink,
        }),
      ).rejects.toMatchObject({ code: "INVALID_PROMPT" });

      await expect(
        executeTaskRun({
          prompt: "triage inbox",
          run: {
            runId: "",
            roleId: "inbox-triage",
            tenantId: "basileia",
            agentRef: { provider: "claude", sessionRef: "sess", isSubagent: false },
          },
          allowedTools: ["Read(src/**)"],
          brokerDependencies: {} as BrokerDependencies,
          auditSink,
        }),
      ).rejects.toMatchObject({ code: "INVALID_RUN" });
    });
  });
}
