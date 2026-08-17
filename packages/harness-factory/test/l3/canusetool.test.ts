import { describe, expect, it, vi } from "vitest";

import {
  createHarness,
  L2_PERMISSION_MODE,
  type CanUseToolPort,
  type PreToolUseHookPort,
} from "../../src/index.js";
import {
  BROKER_PRETOOLUSE_PATH,
  BROKER_TIMEOUT_MS,
  createL1PreToolUseHook,
} from "../../src/hooks/pretooluse.js";
import { createL3CanUseTool } from "../../src/l3/canusetool.js";

const run = {
  runId: "run-1",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-1", isSubagent: false },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function adapter(fetchImpl: typeof fetch) {
  return createL3CanUseTool({
    broker: { fetch: fetchImpl, baseUrl: "http://broker.example" },
    run,
  });
}

describe("createL3CanUseTool — secondary broker callback", () => {
  it("uses the same endpoint and toolUseId as L1 so the broker owns R2 idempotency", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`http://broker.example${BROKER_PRETOOLUSE_PATH}`);
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ decision: "allow", auditEventId: "evt-1" });
    });
    const l3 = adapter(fetchImpl);

    await expect(
      l3.canUseTool({ toolName: "Bash", toolUseId: "shared-tool-1", input: { command: "ls" } }),
    ).resolves.toEqual({ behavior: "allow", updatedInput: { command: "ls" } });

    expect(bodies).toEqual([
      {
        toolUseId: "shared-tool-1",
        runId: "run-1",
        roleId: "inbox-triage",
        tenantId: "basileia",
        toolName: "Bash",
        input: { command: "ls" },
        agentRef: { provider: "claude", sessionRef: "sess-1", isSubagent: false },
      },
    ]);
  });

  it("shares one broker decision and audit event with L1 for a toolUseId", async () => {
    const decisions = new Map<string, { auditEventId: string }>();
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { toolUseId: string };
      const decision = decisions.get(body.toolUseId) ?? { auditEventId: `evt-${decisions.size + 1}` };
      decisions.set(body.toolUseId, decision);
      return jsonResponse({ decision: "allow", ...decision });
    };
    const options = { broker: { fetch: fetchImpl, baseUrl: "http://broker.example" }, run };
    const l1 = createL1PreToolUseHook(options);
    const l3 = createL3CanUseTool(options);
    const request = { toolName: "AskUserQuestion", toolUseId: "same-tool-call", input: { question: "Continue?" } };

    await expect(l1.handle(request)).resolves.toEqual({ decision: "allow" });
    await expect(l3.canUseTool(request)).resolves.toEqual({
      behavior: "allow",
      updatedInput: { question: "Continue?" },
    });
    expect(decisions).toEqual(new Map([["same-tool-call", { auditEventId: "evt-1" }]]));
  });

  it.each([
    "AskUserQuestion",
    "mcp__calendar__confirm_interaction",
    "connector__gmail__ask_before_send",
  ])("routes F5-capable callback tool %s through the broker", async (toolName) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ decision: "allow", auditEventId: "evt-f5" }),
    );

    await expect(
      adapter(fetchImpl).canUseTool({ toolName, toolUseId: `f5-${toolName}`, input: {} }),
    ).resolves.toEqual({ behavior: "allow", updatedInput: {} });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("maps broker denial and preserves updatedInput on allow", async () => {
    const denied = adapter(async () =>
      jsonResponse({ decision: "deny", reason: "approval_pending", auditEventId: "evt-2" }),
    );
    await expect(
      denied.canUseTool({ toolName: "AskUserQuestion", toolUseId: "tool-2", input: {} }),
    ).resolves.toEqual({ behavior: "deny", message: "approval_pending" });

    const updated = adapter(async () =>
      jsonResponse({ decision: "allow", auditEventId: "evt-3", updatedInput: { answer: "safe" } }),
    );
    await expect(
      updated.canUseTool({ toolName: "AskUserQuestion", toolUseId: "tool-3", input: {} }),
    ).resolves.toEqual({ behavior: "allow", updatedInput: { answer: "safe" } });
  });

  it("fails closed on transport error, 10-second timeout, and malformed body", async () => {
    await expect(
      adapter(async () => {
        throw new TypeError("fetch failed");
      }).canUseTool({ toolName: "Read", toolUseId: "transport", input: {} }),
    ).resolves.toEqual({ behavior: "deny", message: "broker.unreachable" });

    vi.useFakeTimers();
    const pending = adapter(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ).canUseTool({ toolName: "Read", toolUseId: "timeout", input: {} });
    await vi.advanceTimersByTimeAsync(BROKER_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ behavior: "deny", message: "broker.timeout" });
    vi.useRealTimers();

    await expect(
      adapter(async () => new Response("not-json", { status: 200 })).canUseTool({
        toolName: "Read",
        toolUseId: "malformed",
        input: {},
      }),
    ).resolves.toEqual({ behavior: "deny", message: "broker.malformed_response" });
  });

  it("is secondary: an L3 allow neither preempts nor replaces the L1 decision", async () => {
    const l1: PreToolUseHookPort = {
      async handle() {
        return { decision: "deny", message: "L1 policy denial" };
      },
    };
    const l3: CanUseToolPort = adapter(async () =>
      jsonResponse({ decision: "allow", auditEventId: "evt-l3" }),
    );
    const harness = createHarness({
      l1,
      l2: { permissionMode: L2_PERMISSION_MODE, allowedTools: [] },
      l3,
      queryFn: async function* () {},
    });

    const l1Callback = harness.invocation.hooks.PreToolUse[0]!.hooks[0]!;
    await expect(
      l1Callback(
        { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "tool-l1", tool_input: {} },
        "tool-l1",
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "L1 policy denial" },
    });
    await expect(
      harness.invocation.canUseTool("Read", {}, {
        signal: new AbortController().signal,
        toolUseID: "tool-l1",
        requestId: "request-1",
      }),
    ).resolves.toEqual({ behavior: "allow", updatedInput: {} });
  });
});
