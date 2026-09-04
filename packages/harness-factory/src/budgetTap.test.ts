import { describe, expect, it } from "vitest";

import {
  BudgetTapError,
  withBudgetTap,
  type BudgetTapReport,
} from "./budgetTap.js";
import type { AgentSdkQueryFn } from "./ports.js";

async function collect(query: AgentSdkQueryFn): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of query({ prompt: "budget tap test" })) {
    events.push(event);
  }
  return events;
}

function queryFrom(events: readonly unknown[]): AgentSdkQueryFn {
  return () => (async function* () { yield* events; })();
}

function sdkResult(costUsd = 0.042): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: costUsd,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2,
    },
    modelUsage: {
      "claude-sonnet": {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
      },
      "claude-haiku": {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  };
}

describe("withBudgetTap", () => {
  it("preserves events and reports a real-shaped SDK result before yielding it", async () => {
    const firstEvent = { type: "assistant", message: "working" };
    const terminalResult = sdkResult();
    const reports: BudgetTapReport[] = [];
    const observed: string[] = [];
    const query = withBudgetTap(queryFrom([firstEvent, terminalResult]), {
      report(report) {
        reports.push(report);
        observed.push("sink");
      },
    });

    const events: unknown[] = [];
    for await (const event of query({ prompt: "budget tap test" })) {
      observed.push(event === terminalResult ? "result" : "other");
      events.push(event);
    }

    expect(events).toEqual([firstEvent, terminalResult]);
    expect(events[1]).toBe(terminalResult);
    expect(reports).toEqual([{ costUsd: 0.042, tokens: 137 }]);
    expect(observed).toEqual(["other", "sink", "result"]);
  });

  it("fails closed without yielding the cost-bearing result when the sink rejects", async () => {
    const firstEvent = { type: "assistant", message: "working" };
    const terminalResult = sdkResult(1.25);
    const query = withBudgetTap(queryFrom([firstEvent, terminalResult]), {
      report() {
        throw new Error("ledger unavailable");
      },
    });

    const iterator = query({ prompt: "budget tap test" })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: firstEvent, done: false });
    await expect(iterator.next()).rejects.toMatchObject({
      name: "BudgetTapError",
      report: { costUsd: 1.25, tokens: 137 },
      cause: expect.objectContaining({ message: "ledger unavailable" }),
    } satisfies Partial<BudgetTapError>);
  });

  it("does not call the sink for a stream without a cost-bearing result", async () => {
    const reports: BudgetTapReport[] = [];
    const events = [{ type: "assistant", message: "partial" }, { type: "system", subtype: "done" }];
    const query = withBudgetTap(queryFrom(events), {
      report(report) {
        reports.push(report);
      },
    });

    await expect(collect(query)).resolves.toEqual(events);
    expect(reports).toEqual([]);
  });
});
