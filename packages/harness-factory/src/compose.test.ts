import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  composeHarness,
  runWithChatBudget,
  type ComposeOptions,
} from "./compose.js";
import type { BudgetTapReport } from "./budgetTap.js";
import type { AgentSdkQueryFn } from "./ports.js";

const composeSource = readFileSync(
  fileURLToPath(new URL("./compose.ts", import.meta.url)),
  "utf8",
);

const RUN = {
  runId: "11111111-1111-4111-8111-111111111111",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-compose-budget", isSubagent: false },
};

/**
 * Empirically verified against `@anthropic-ai/claude-agent-sdk` sdk.d.ts
 * (SDKResultSuccess / ModelUsage): terminal `{type:"result"}` carries
 * numeric `total_cost_usd` and per-model `modelUsage` with camelCase token
 * fields. `usage` is main-agent-only — the tap prefers `modelUsage`.
 */
function sdkResult(costUsd = 0.042): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    total_cost_usd: costUsd,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
    },
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
      },
    },
  };
}

function sink(): { writes: unknown[]; port: { writeCompletionEvidence: () => Promise<void> } } {
  return { writes: [], port: { writeCompletionEvidence: async () => undefined } };
}

function options(overrides: Partial<ComposeOptions> = {}): ComposeOptions {
  return {
    run: RUN,
    allowedTools: ["Bash(ls *)", "Read(src/**)"],
    auditSink: sink().port,
    pretooluse: {
      handlePreToolUse: async (request) => ({
        decision: "allow",
        tier: "T0_observe",
        auditEventId: `audit:${request.toolUseId}`,
      }),
      dependencies: {},
    },
    queryFn: async function* () {},
    ...overrides,
  };
}

async function collect(query: AgentSdkQueryFn): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of query({ prompt: "budget compose test" })) {
    events.push(event);
  }
  return events;
}

async function invokePreToolUse(
  composed: ReturnType<typeof composeHarness>,
  toolName = "Read",
): Promise<Record<string, unknown>> {
  const hook = composed.harness.invocation.hooks.PreToolUse[0]!.hooks[0]!;
  return hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_use_id: "tool-budget-1",
      tool_input: { file_path: "src/index.ts" },
    },
    "tool-budget-1",
    { signal: new AbortController().signal },
  );
}

describe("composeHarness — Claude SDK budget tap (TASK-163)", () => {
  it("is a live composition: withBudgetTap wraps the final harness.query", () => {
    expect(composeSource).toContain("withBudgetTap");
    expect(composeSource).toContain("runWithChatBudget");
    expect(composeSource).toContain("withBudgetGate");
  });

  it("reports a real-shaped SDK result before yielding it when budgetTap is set", async () => {
    const terminal = sdkResult();
    const reports: BudgetTapReport[] = [];
    const composed = composeHarness(
      options({
        queryFn: async function* () {
          yield { type: "assistant", message: "working" };
          yield terminal;
        },
        budgetTap: {
          report(report) {
            reports.push(report);
          },
        },
      }),
    );

    const events = await collect(composed.harness.query);
    expect(events).toEqual([{ type: "assistant", message: "working" }, terminal]);
    expect(reports).toEqual([{ costUsd: 0.042, tokens: 127 }]);
  });

  it("fails closed without yielding the cost-bearing result when the sink rejects", async () => {
    const terminal = sdkResult(1.25);
    const composed = composeHarness(
      options({
        queryFn: async function* () {
          yield terminal;
        },
        budgetTap: {
          report() {
            throw new Error("ledger unavailable");
          },
        },
      }),
    );

    const iterator = composed.harness.query({ prompt: "budget compose test" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      name: "BudgetTapError",
      report: { costUsd: 1.25, tokens: 127 },
    });
  });

  it("leaves a cost-less stream un-tapped when no budgetTap is bound", async () => {
    const events = [{ type: "assistant", message: "partial" }];
    const composed = composeHarness(
      options({
        queryFn: async function* () {
          yield* events;
        },
      }),
    );
    await expect(collect(composed.harness.query)).resolves.toEqual(events);
  });

  it("honors runWithChatBudget as the production wiring channel (no ComposeOptions.budgetTap)", async () => {
    const reports: BudgetTapReport[] = [];
    const terminal = sdkResult(0.5);
    const events = await runWithChatBudget(
      {
        tap: {
          report(report) {
            reports.push(report);
          },
        },
      },
      async () => {
        const composed = composeHarness(
          options({
            queryFn: async function* () {
              yield terminal;
            },
          }),
        );
        return collect(composed.harness.query);
      },
    );
    expect(events).toEqual([terminal]);
    expect(reports).toEqual([{ costUsd: 0.5, tokens: 127 }]);
  });
});

describe("composeHarness — Claude SDK budget gate (TASK-163)", () => {
  it("denies PreToolUse with the budget reason before the broker runs", async () => {
    let brokerCalls = 0;
    const composed = composeHarness(
      options({
        budgetCheck: async () => ({ decision: "deny", reason: "budget.platform_exceeded" }),
        pretooluse: {
          handlePreToolUse: async () => {
            brokerCalls += 1;
            return { decision: "allow", tier: "T0_observe", auditEventId: "audit:x" };
          },
          dependencies: {},
        },
      }),
    );
    const result = await invokePreToolUse(composed);
    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "budget.platform_exceeded",
      },
    });
    expect(brokerCalls).toBe(0);
  });

  it("fails closed on a throwing budget check", async () => {
    const composed = composeHarness(
      options({
        budgetCheck: async () => {
          throw new Error("budget.read_timeout: exceeded 9500ms");
        },
      }),
    );
    const result = await invokePreToolUse(composed);
    expect(result).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "budget.check_failed: budget.read_timeout: exceeded 9500ms",
      },
    });
  });

  it("allows PreToolUse through to the broker when the check allows", async () => {
    const composed = composeHarness(
      options({
        budgetCheck: async () => ({ decision: "allow" }),
      }),
    );
    const result = await invokePreToolUse(composed);
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });

  it("honors runWithChatBudget for the L1 gate without ComposeOptions.budgetCheck", async () => {
    const result = await runWithChatBudget(
      {
        tap: { report() { /* recording is a sibling concern */ } },
        check: async () => ({ decision: "deny", reason: "budget.routine_exceeded" }),
      },
      async () => invokePreToolUse(composeHarness(options())),
    );
    expect(result).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "budget.routine_exceeded",
      },
    });
  });
});
