import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  createHarness,
  L2_PERMISSION_MODE,
  SUBPROCESS_TOOL_NAME,
  type GateSubprocess,
  type SubprocessSpawnRequest,
} from "../src/index.js";
import {
  CAN02_TIER3_BARE_NAME,
  composeHarness,
  createInProcessBrokerPort,
  type BrokerDecisionRequest,
  type BrokerDecisionResponse,
  type ComposeOptions,
} from "../src/compose.js";
import type { CompletionEvidence } from "../src/hooks/posttooluse.js";
import { BROKER_TIMEOUT_MS } from "../src/hooks/pretooluse.js";

const composeSource = readFileSync(
  fileURLToPath(new URL("../src/compose.ts", import.meta.url)),
  "utf8",
);

const RUN = {
  runId: "11111111-1111-4111-8111-111111111111",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-compose", isSubagent: false },
};

interface FakeProvider {
  readonly gate: GateSubprocess;
  spawned: number;
  lastDeny?: string;
}

function fakeProvider(gate: GateSubprocess): FakeProvider {
  return { gate, spawned: 0 };
}

async function trySpawn(provider: FakeProvider, request: SubprocessSpawnRequest): Promise<void> {
  const result = await provider.gate(request);
  if (result.allow === true) {
    provider.spawned += 1;
    return;
  }
  provider.lastDeny = result.message;
}

function sink(): { writes: CompletionEvidence[]; port: { writeCompletionEvidence: (e: CompletionEvidence) => Promise<void> } } {
  const writes: CompletionEvidence[] = [];
  return {
    writes,
    port: {
      async writeCompletionEvidence(evidence) {
        writes.push(evidence);
      },
    },
  };
}

function allowHandle(
  request: BrokerDecisionRequest,
): Promise<BrokerDecisionResponse> {
  return Promise.resolve({
    decision: "allow",
    tier: "T0_observe",
    auditEventId: `audit:${request.toolUseId}`,
  });
}

function denyHandle(
  request: BrokerDecisionRequest,
): Promise<BrokerDecisionResponse> {
  return Promise.resolve({
    decision: "deny",
    reason: "approval_pending",
    auditEventId: `audit:${request.toolUseId}`,
    approvalId: "appr-1",
  });
}

function options(
  overrides: Partial<ComposeOptions<Record<string, never>, FakeProvider, FakeProvider>> = {},
): ComposeOptions<Record<string, never>, FakeProvider, FakeProvider> {
  const audit = sink();
  return {
    run: RUN,
    allowedTools: ["Bash(ls *)", "Read(src/**)"],
    auditSink: audit.port,
    pretooluse: {
      handlePreToolUse: async (request) => allowHandle(request),
      dependencies: {},
    },
    queryFn: async function* () {},
    subprocessProviders: {
      createCodex: fakeProvider,
      createGrok: fakeProvider,
    },
    ...overrides,
  };
}

describe("composeHarness — sole composition root", () => {
  it("is reachable from the public package entry point", async () => {
    const publicCompose = await import("@oikonomos/harness-factory/compose");
    expect(typeof publicCompose.composeHarness).toBe("function");

    const composed = publicCompose.composeHarness(options());
    expect(composed.harness.config.permissionMode).toBe(L2_PERMISSION_MODE);
  });

  it("imports the three adapters + PostToolUse and only createHarness constructs the SDK path", () => {
    expect(composeSource).toContain("pretooluse.js");
    expect(composeSource).toContain("allowed-tools.js");
    expect(composeSource).toContain("canusetool.js");
    expect(composeSource).toContain("posttooluse.js");
    expect(composeSource).toContain("createHarness");
    expect(composeSource).toContain("createL1PreToolUseHook");
    expect(composeSource).toContain("createL2Policy");
    expect(composeSource).toContain("createL3CanUseTool");
    expect(composeSource).toContain("createPostToolUseHook");
    expect(composeSource).not.toMatch(/\bfunction\s+createHarness\b/);
    expect(composeSource).not.toContain("hooks/pretooluse");
    expect(composeSource).not.toContain("l2/allowed-tools");
    expect(composeSource).not.toContain("l3/canusetool");
  });

  it("wires L1, dontAsk L2, L3, and PostToolUse into createHarness", async () => {
    const composed = composeHarness(options());
    const { harness } = composed;

    expect(harness.config.permissionMode).toBe(L2_PERMISSION_MODE);
    expect(harness.config.allowedTools).toEqual(["Bash(ls *)", "Read(src/**)"]);
    expect(harness.invocation.hooks.PreToolUse).toHaveLength(1);
    expect(harness.invocation.hooks.PostToolUse).toHaveLength(1);
    expect(typeof harness.invocation.canUseTool).toBe("function");
    expect(typeof harness.gateSubprocess).toBe("function");

    const hook = harness.invocation.hooks.PreToolUse[0]!.hooks[0]!;
    const allowed = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "tool-compose-1",
        tool_input: { path: "src/index.ts" },
      },
      "tool-compose-1",
      { signal: new AbortController().signal },
    );
    expect(allowed).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  });

  it("still uses createHarness as the sole constructor (OIK-033)", () => {
    const harness = createHarness({
      l1: { async handle() { return { decision: "deny", message: "unused" }; } },
      l2: { permissionMode: L2_PERMISSION_MODE, allowedTools: [] },
      l3: { async canUseTool() { return { behavior: "deny", message: "unused" }; } },
      queryFn: async function* () {},
    });
    expect(harness.invocation.permissionMode).toBe(L2_PERMISSION_MODE);
  });
});

describe("composeHarness — ADR-001 R3 run parking", () => {
  it("parks approval_pending after denying the Tier-3 call", async () => {
    const parked: Array<{ toolUseId: string; reason: string }> = [];
    const composed = composeHarness(
      options({
        pretooluse: {
          handlePreToolUse: async (request) => denyHandle(request),
          dependencies: {},
        },
        park: {
          async park(request) {
            parked.push(request);
          },
        },
      }),
    );

    const hook = composed.harness.invocation.hooks.PreToolUse[0]!.hooks[0]!;
    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "approval-waiting",
        tool_input: { command: "rm -rf /" },
      },
      "approval-waiting",
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "approval_pending",
      },
    });
    expect(parked).toEqual([{ toolUseId: "approval-waiting", reason: "approval_pending" }]);
  });

  it.each([
    ["broker.http_500", async () => new Response("unavailable", { status: 500 })],
    ["broker.malformed_response", async () => new Response("not-json", { status: 200 })],
    ["broker.unreachable", async () => { throw new Error("offline"); }],
  ])("keeps fail-closed parking for %s", async (reason, fetch) => {
    const parked: Array<{ toolUseId: string; reason: string }> = [];
    const composed = composeHarness(
      options({
        pretooluse: undefined,
        broker: { baseUrl: "http://broker.test", fetch },
        park: {
          async park(request) {
            parked.push(request);
          },
        },
      }),
    );
    const hook = composed.harness.invocation.hooks.PreToolUse[0]!.hooks[0]!;
    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: `fail-closed-${reason}`,
        tool_input: { path: "secret" },
      },
      `fail-closed-${reason}`,
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason },
    });
    expect(parked).toEqual([{ toolUseId: `fail-closed-${reason}`, reason }]);
  });

  it("keeps fail-closed parking for broker.timeout", async () => {
    vi.useFakeTimers();
    try {
      const parked: Array<{ toolUseId: string; reason: string }> = [];
      const composed = composeHarness(
        options({
          pretooluse: undefined,
          broker: {
            baseUrl: "http://broker.test",
            fetch: (_input, init) =>
              new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                  const error = new Error("This operation was aborted");
                  error.name = "AbortError";
                  reject(error);
                });
              }),
          },
          park: {
            async park(request) {
              parked.push(request);
            },
          },
        }),
      );
      const hook = composed.harness.invocation.hooks.PreToolUse[0]!.hooks[0]!;
      const toolUseId = "fail-closed-broker.timeout";
      const pending = hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_use_id: toolUseId,
          tool_input: { path: "secret" },
        },
        toolUseId,
        { signal: new AbortController().signal },
      );

      await vi.advanceTimersByTimeAsync(BROKER_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "broker.timeout",
        },
      });
      expect(parked).toEqual([{ toolUseId, reason: "broker.timeout" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("composeHarness — Codex/Grok subprocess gate", () => {
  it("binds harness.gateSubprocess into both providers", () => {
    const composed = composeHarness(options());
    expect(composed.providers.codex?.gate).toBe(composed.harness.gateSubprocess);
    expect(composed.providers.grok?.gate).toBe(composed.harness.gateSubprocess);
  });

  it("deny from L1 means the provider never reaches spawn", async () => {
    const composed = composeHarness(
      options({
        pretooluse: {
          handlePreToolUse: async (request) => denyHandle(request),
          dependencies: {},
        },
      }),
    );
    const request: SubprocessSpawnRequest = {
      provider: "codex",
      command: "codex",
      args: ["exec", "--json", "must-not-run"],
      cwd: "/workspace",
    };

    await trySpawn(composed.providers.codex!, request);
    await trySpawn(composed.providers.grok!, { ...request, provider: "grok", command: "grok" });

    expect(composed.providers.codex?.spawned).toBe(0);
    expect(composed.providers.grok?.spawned).toBe(0);
    expect(composed.providers.codex?.lastDeny).toBe("approval_pending");
    expect(composed.providers.grok?.lastDeny).toBe("approval_pending");
  });

  it("allow from L1 is the only path that increments spawn", async () => {
    const composed = composeHarness(options());
    await trySpawn(composed.providers.codex!, {
      provider: "codex",
      command: "codex",
      args: ["exec"],
      cwd: "/workspace",
    });
    expect(composed.providers.codex?.spawned).toBe(1);
  });

  it("gate presents the spawn to L1 as the Bash tool", async () => {
    const seen: string[] = [];
    const composed = composeHarness(
      options({
        pretooluse: {
          handlePreToolUse: async (request) => {
            seen.push(request.toolName);
            return denyHandle(request);
          },
          dependencies: {},
        },
      }),
    );
    await trySpawn(composed.providers.codex!, {
      provider: "codex",
      command: "codex",
      args: [],
      cwd: "/tmp",
    });
    expect(seen).toEqual([SUBPROCESS_TOOL_NAME]);
  });
});

describe("createInProcessBrokerPort", () => {
  it("POSTs through handlePreToolUse and maps HTTP 500 on throw", async () => {
    const port = createInProcessBrokerPort(async () => {
      throw new Error("boom");
    }, {});
    const response = await port.fetch("http://oikonomos.broker.local/v1/broker/pretooluse", {
      method: "POST",
      body: JSON.stringify({
        toolUseId: "t",
        runId: RUN.runId,
        roleId: RUN.roleId,
        tenantId: RUN.tenantId,
        toolName: "Read",
        input: {},
        agentRef: RUN.agentRef,
      }),
    });
    expect(response.status).toBe(500);
  });
});

describe("CAN-02 fixture constant", () => {
  it("names the ADR-001 bare-name Tier-3 tool", () => {
    expect(CAN02_TIER3_BARE_NAME).toBe("mcp__gmail__send_message");
  });
});
