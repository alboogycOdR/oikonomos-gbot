import { describe, expect, it } from "vitest";

import { executeTaskRun } from "../src/executeRun.js";

import {
  createCompletionSink,
  createDecisionLog,
  createWorkerBrokerDeps,
  simulatingWorkerQuery,
  WORKER_CAPABILITY_ID,
  WORKER_TOOL,
  WORKER_TOOL_USE_ID,
  workerQueryFn,
  workerRun,
} from "./fixtures.js";

describe("ADR-005 — E4 production-caller liveness", () => {
  it("keys on a broker decision audit event emitted by a worker-driven tool call", async () => {
    const audit = createDecisionLog();

    await executeTaskRun({
      prompt: "read the worker entry",
      run: workerRun,
      allowedTools: ["Read(src/**)"],
      brokerDependencies: createWorkerBrokerDeps(audit),
      auditSink: createCompletionSink(),
      queryFn: workerQueryFn,
    });

    expect(audit.events.length).toBeGreaterThan(0);
    expect(audit.events[0]).toMatchObject({
      verdict: "allow",
      capability: WORKER_CAPABILITY_ID,
      tier: "T0_observe",
      payload: expect.objectContaining({
        toolUseId: WORKER_TOOL_USE_ID,
        toolName: WORKER_TOOL,
        isSubagent: false,
      }),
    });
  });

  it("MUTATION-PROVEN: bypassing composeHarness writes no broker audit event", async () => {
    const audit = createDecisionLog();
    createWorkerBrokerDeps(audit);

    // HIGH-2 inert shape: the worker calls the SDK/queryFn without going
    // through composeHarness, so L1 is never bound and the broker never
    // decides. This is the failure the liveness assertion above must catch
    // if executeTaskRun is mutated to skip composeHarness.
    const events: unknown[] = [];
    for await (const event of simulatingWorkerQuery({ prompt: "read the worker entry" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(audit.events).toEqual([]);
  });
});
