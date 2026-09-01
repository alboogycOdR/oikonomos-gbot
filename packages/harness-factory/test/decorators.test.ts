import { describe, expect, it } from "vitest";

import {
  currentApprovalScope,
  decorateTool,
  MissingToolCallIdError,
  ToolTimeoutError,
  withApprovalScope,
  withMandatoryCallId,
  withToolTimeout,
  type TimerClock,
} from "../src/decorators/index.js";
import { composeHarness, type ComposeOptions } from "../src/compose.js";

const RUN = {
  runId: "run-decorators",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "session-decorators", isSubagent: false },
};

function composeOptions(overrides: Partial<ComposeOptions> = {}): ComposeOptions {
  return {
    run: RUN,
    allowedTools: ["Read(src/**)"],
    auditSink: { async writeCompletionEvidence() {} },
    pretooluse: {
      dependencies: {},
      async handlePreToolUse() {
        return { decision: "allow", tier: "T0_observe", auditEventId: "audit-decorators" };
      },
    },
    queryFn: async function* () {},
    ...overrides,
  };
}

describe("tool decorators", () => {
  it("makes scope available to nested calls and retires it when the tool throws", async () => {
    const retired: string[] = [];
    const tool = withApprovalScope({ runId: RUN.runId, onRetire: (scope) => retired.push(scope.toolCallId) })({
      name: "nested",
      async execute() {
        await Promise.resolve();
        expect(currentApprovalScope()).toEqual({
          runId: RUN.runId,
          toolCallId: "call-nested",
          approvalNonce: "nonce-nested",
        });
        throw new Error("tool failed");
      },
    });

    await expect(tool.execute({}, { toolCallId: "call-nested", approvalNonce: "nonce-nested" })).rejects.toThrow("tool failed");
    expect(retired).toEqual(["call-nested"]);
    expect(currentApprovalScope()).toBeUndefined();
  });

  it("throws a typed error before executing when toolCallId is absent", async () => {
    let executions = 0;
    const tool = withMandatoryCallId()({
      name: "identity-required",
      async execute() {
        executions += 1;
        return "unexpected";
      },
    });
    await expect(tool.execute({}, {})).rejects.toBeInstanceOf(MissingToolCallIdError);
    expect(executions).toBe(0);
  });

  it("uses the timeout for the current tool name and clears it after success", async () => {
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const cleared: number[] = [];
    const clock: TimerClock = {
      setTimeout(callback) {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id;
      },
      clearTimeout(timer) {
        cleared.push(timer as number);
        timers.delete(timer as number);
      },
    };
    const tool = withToolTimeout({
      clock,
      timeoutMsForTool: (name) => (name === "quick" ? 25 : undefined),
    })({ name: "quick", async execute() { return "ok"; } });
    await expect(tool.execute({}, { toolCallId: "call-timeout" })).resolves.toBe("ok");
    expect(cleared).toEqual([1]);
    expect(timers.size).toBe(0);
  });

  it("rejects when the named timeout fires", async () => {
    let fire: (() => void) | undefined;
    const clock: TimerClock = {
      setTimeout(callback) { fire = callback; return 1; },
      clearTimeout() {},
    };
    const tool = withToolTimeout({ clock, timeoutMsForTool: () => 5 })({
      name: "slow",
      async execute() { return new Promise<string>(() => {}); },
    });
    const pending = tool.execute({}, { toolCallId: "call-slow" });
    fire?.();
    await expect(pending).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it("composeHarness decorates every mounted tool", async () => {
    const composed = composeHarness(composeOptions({
      mountedTools: [
        { name: "first", async execute() { return "first"; } },
        { name: "second", async execute() { return "second"; } },
      ],
    }));

    await expect(composed.mountedTools[0]!.execute({}, {})).rejects.toBeInstanceOf(MissingToolCallIdError);
    await expect(composed.mountedTools[1]!.execute({}, {})).rejects.toBeInstanceOf(MissingToolCallIdError);
  });

  it("MUTATION-PROVEN: an undecorated mounted tool makes the identity assertion fail", async () => {
    const undecorated = { name: "escaped", async execute() { return "escaped"; } };
    await expect(undecorated.execute({}, {})).resolves.toBe("escaped");
    const decorated = decorateTool(undecorated, [withMandatoryCallId()]);
    await expect(decorated.execute({}, {})).rejects.toBeInstanceOf(MissingToolCallIdError);
  });
});
