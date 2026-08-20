import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composeHarness,
  McpConfigError,
  resolveMcpServers,
  type BrokerDecisionRequest,
  type BrokerDecisionResponse,
  type ComposeOptions,
} from "../src/compose.js";
import {
  bannedModeTokens,
  L2_PERMISSION_MODE,
  type AgentSdkQueryInput,
  type Harness,
  type SdkHookCallback,
} from "../src/index.js";
import type { CompletionEvidence } from "../src/hooks/posttooluse.js";
import type { SdkMcpServers } from "../src/mcp/index.js";

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
const composeSource = readFileSync(join(srcRoot, "compose.ts"), "utf8");
const factorySource = readFileSync(join(srcRoot, "index.ts"), "utf8");
const l1Source = readFileSync(join(srcRoot, "hooks", "pretooluse.ts"), "utf8");

const RUN = {
  runId: "22222222-2222-4222-8222-222222222222",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-mcp", isSubagent: false },
};

/** Distinct marker strings used only to assert they never appear in errors/logs (N4). */
const SUPPLIED_URL = "https://mcp.test.invalid/v1?token=NOT-A-REAL-SECRET";
const SUPPLIED_HEADER = "Bearer NOT-A-REAL-SECRET";

const MCP_SERVER = "fake";
const MCP_TOOL = "list";
const MCP_TOOL_NAME = `mcp__${MCP_SERVER}__${MCP_TOOL}`;

interface FakeMcpServer {
  readonly name: string;
  readonly invocations: Array<{ tool: string; input: Record<string, unknown> }>;
  invoke(tool: string, input: Record<string, unknown>): Promise<unknown>;
  qualifiedName(tool: string): string;
}

function createFakeInProcessMcpServer(name: string): FakeMcpServer {
  const invocations: FakeMcpServer["invocations"] = [];
  return {
    name,
    invocations,
    qualifiedName(tool) {
      return `mcp__${name}__${tool}`;
    },
    async invoke(tool, input) {
      invocations.push({ tool, input });
      return { ok: true, tool };
    },
  };
}

function sink(): {
  writes: CompletionEvidence[];
  port: { writeCompletionEvidence: (e: CompletionEvidence) => Promise<void> };
} {
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

function allowHandle(request: BrokerDecisionRequest): Promise<BrokerDecisionResponse> {
  return Promise.resolve({
    decision: "allow",
    tier: "T0_observe",
    auditEventId: `audit:${request.toolUseId}`,
  });
}

function denyHandle(request: BrokerDecisionRequest): Promise<BrokerDecisionResponse> {
  return Promise.resolve({
    decision: "deny",
    reason: "capability.denied",
    auditEventId: `audit:${request.toolUseId}`,
  });
}

function options(
  overrides: Partial<ComposeOptions<Record<string, never>>> = {},
): ComposeOptions<Record<string, never>> {
  return {
    run: RUN,
    allowedTools: ["Bash(ls *)", `${MCP_TOOL_NAME}(*)`],
    auditSink: sink().port,
    pretooluse: {
      handlePreToolUse: async (request) => allowHandle(request),
      dependencies: {},
    },
    queryFn: async function* () {},
    ...overrides,
  };
}

async function composeAndCapture(
  overrides: Partial<ComposeOptions<Record<string, never>>> = {},
): Promise<{ captured: AgentSdkQueryInput[]; harness: Harness; seen: string[] }> {
  const captured: AgentSdkQueryInput[] = [];
  const seen: string[] = [];
  const composed = composeHarness(
    options({
      queryFn: async function* (queryInput) {
        captured.push(queryInput);
      },
      pretooluse: {
        handlePreToolUse: async (request) => {
          seen.push(request.toolName);
          return denyHandle(request);
        },
        dependencies: {},
      },
      mcpServers: {
        [MCP_SERVER]: {
          transport: "http",
          url: SUPPLIED_URL,
          headers: { Authorization: SUPPLIED_HEADER },
        },
      },
      ...overrides,
    }),
  );
  for await (const _ of composed.harness.query({ prompt: "list mail" })) {
    void _;
  }
  return { captured, harness: composed.harness, seen };
}

function preToolUseHook(harness: Harness): SdkHookCallback {
  const hook = harness.invocation.hooks.PreToolUse[0]?.hooks[0];
  if (!hook) {
    throw new Error("composed harness has no PreToolUse hook");
  }
  return hook;
}

async function invokeMountedMcpTool(args: {
  harness: Harness;
  fake: FakeMcpServer;
  tool?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  hook?: SdkHookCallback;
}): Promise<{ executed: boolean; decision: string | undefined; output: Record<string, unknown> }> {
  const tool = args.tool ?? MCP_TOOL;
  const toolUseId = args.toolUseId ?? "mcp-tool-1";
  const input = args.input ?? { query: "inbox" };
  const hook = args.hook ?? preToolUseHook(args.harness);
  const output = await hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: args.fake.qualifiedName(tool),
      tool_use_id: toolUseId,
      tool_input: input,
    },
    toolUseId,
    { signal: new AbortController().signal },
  );
  const decision = (
    output as { hookSpecificOutput?: { permissionDecision?: string } }
  ).hookSpecificOutput?.permissionDecision;
  if (decision !== "allow") {
    return { executed: false, decision, output };
  }
  await args.fake.invoke(tool, input);
  return { executed: true, decision, output };
}

function bypassMcpBeforeL1(hook: SdkHookCallback): SdkHookCallback {
  return async (input, toolUseID, hookOptions) => {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    if (toolName.startsWith("mcp__")) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      };
    }
    return hook(input, toolUseID, hookOptions);
  };
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      out.push(...walkTs(abs));
      continue;
    }
    if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

describe("composeHarness — mcpServers reaches the SDK options (N9)", () => {
  it("accepts mcpServers and attaches the mapped SDK record on query options", async () => {
    const { captured, harness } = await composeAndCapture();
    expect(harness.config.permissionMode).toBe(L2_PERMISSION_MODE);
    expect(captured).toHaveLength(1);
    const sdkOptions = captured[0]?.options as { mcpServers?: SdkMcpServers };
    expect(sdkOptions.mcpServers).toEqual({
      [MCP_SERVER]: {
        type: "http",
        url: SUPPLIED_URL,
        headers: { Authorization: SUPPLIED_HEADER },
      },
    });
  });

  it("maps stdio transport to the SDK type/command/args shape", async () => {
    const captured: AgentSdkQueryInput[] = [];
    const composed = composeHarness(
      options({
        queryFn: async function* (queryInput) {
          captured.push(queryInput);
        },
        mcpServers: {
          local: { transport: "stdio", command: "node", args: ["./servers/fake.js"] },
        },
      }),
    );
    for await (const _ of composed.harness.query({ prompt: "x" })) {
      void _;
    }
    expect((captured[0]?.options as { mcpServers: SdkMcpServers }).mcpServers).toEqual({
      local: { type: "stdio", command: "node", args: ["./servers/fake.js"] },
    });
  });

  it("does not set mcpServers on the SDK options when the field is omitted", async () => {
    const captured: AgentSdkQueryInput[] = [];
    const composed = composeHarness(
      options({
        queryFn: async function* (queryInput) {
          captured.push(queryInput);
        },
      }),
    );
    for await (const _ of composed.harness.query({ prompt: "x" })) {
      void _;
    }
    expect(captured[0]?.options).not.toHaveProperty("mcpServers");
  });

  it("overwrites caller mcpServers so composeHarness stays the sole setter", async () => {
    const { captured } = await composeAndCapture();
    const capturedAgain: AgentSdkQueryInput[] = [];
    const composed = composeHarness(
      options({
        queryFn: async function* (queryInput) {
          capturedAgain.push(queryInput);
        },
        mcpServers: {
          fake: { transport: "http", url: SUPPLIED_URL },
        },
      }),
    );
    for await (const _ of composed.harness.query({
      prompt: "x",
      options: {
        mcpServers: { attacker: { type: "http", url: "https://evil.example/mcp" } },
      },
    })) {
      void _;
    }
    expect((capturedAgain[0]?.options as { mcpServers: SdkMcpServers }).mcpServers).toEqual({
      fake: { type: "http", url: SUPPLIED_URL },
    });
    expect(Object.keys((captured[0]?.options as { mcpServers: SdkMcpServers }).mcpServers)).toEqual(
      [MCP_SERVER],
    );
  });

  it("N9: attachMcpServersToQuery is invoked only from composeHarness", () => {
    const callers: string[] = [];
    for (const file of walkTs(srcRoot)) {
      const body = readFileSync(file, "utf8");
      if (!body.includes("attachMcpServersToQuery(")) continue;
      const rel = file.slice(srcRoot.length + 1).replaceAll("\\", "/");
      callers.push(rel);
    }
    expect(callers.sort()).toEqual(["compose.ts", "mcp/attach.ts"]);
    expect(composeSource).toContain("attachMcpServersToQuery(created.query, mcpServers)");
    expect(factorySource).not.toContain("mcpServers");
  });
});

describe("MCP tools traverse L1 exactly like built-in tools (ADR-001 N1)", () => {
  it("DECISIVE: an mcp__* call from a mounted fake server reaches L1 and a deny prevents it", async () => {
    const fake = createFakeInProcessMcpServer(MCP_SERVER);
    const seen: string[] = [];
    const composed = composeHarness(
      options({
        mcpServers: {
          [MCP_SERVER]: { transport: "http", url: "http://oikonomos.mcp.fake.local/fake" },
        },
        pretooluse: {
          handlePreToolUse: async (request) => {
            seen.push(request.toolName);
            return denyHandle(request);
          },
          dependencies: {},
        },
      }),
    );

    const outcome = await invokeMountedMcpTool({
      harness: composed.harness,
      fake,
      toolUseId: "mcp-deny-1",
    });

    expect(seen).toEqual([MCP_TOOL_NAME]);
    expect(outcome.decision).toBe("deny");
    expect(outcome.executed).toBe(false);
    expect(fake.invocations).toEqual([]);
    expect(outcome.output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "capability.denied",
      },
    });
  });

  it("MUTATION-PROVEN: an early-return that skips L1 for mcp__* names makes the decisive assertion fail", async () => {
    const fake = createFakeInProcessMcpServer(MCP_SERVER);
    const seen: string[] = [];
    const composed = composeHarness(
      options({
        mcpServers: {
          [MCP_SERVER]: { transport: "http", url: "http://oikonomos.mcp.fake.local/fake" },
        },
        pretooluse: {
          handlePreToolUse: async (request) => {
            seen.push(request.toolName);
            return denyHandle(request);
          },
          dependencies: {},
        },
      }),
    );

    const mutated = await invokeMountedMcpTool({
      harness: composed.harness,
      fake,
      hook: bypassMcpBeforeL1(preToolUseHook(composed.harness)),
      toolUseId: "mcp-mutate-1",
    });

    expect(seen).toEqual([]);
    expect(mutated.decision).toBe("allow");
    expect(mutated.executed).toBe(true);
    expect(fake.invocations).toEqual([{ tool: MCP_TOOL, input: { query: "inbox" } }]);
  });

  it("does not special-case mcp__ names before the L1 handle() call", () => {
    const mcpSources = walkTs(join(srcRoot, "mcp")).map((file) => readFileSync(file, "utf8"));
    const bodies = [composeSource, factorySource, l1Source, ...mcpSources];
    for (const body of bodies) {
      expect(body).not.toMatch(/startsWith\(\s*["']mcp__/);
      expect(body).not.toMatch(/toolName\s*===\s*["']mcp__/);
    }
    expect(factorySource).toContain("decision = await port.handle(");
    expect(l1Source).toContain("async handle(request: PreToolUsePortRequest)");
  });

  it("fail-closed: broker deny/throw for an MCP tool matches a built-in tool (N3)", async () => {
    const throwing = composeHarness(
      options({
        mcpServers: {
          [MCP_SERVER]: { transport: "http", url: "http://oikonomos.mcp.fake.local/fake" },
        },
        pretooluse: {
          handlePreToolUse: async () => {
            throw new Error("broker exploded");
          },
          dependencies: {},
        },
      }),
    );
    const hook = preToolUseHook(throwing.harness);
    const signal = new AbortController().signal;

    const builtin = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "built-in-throw",
        tool_input: { path: "src/index.ts" },
      },
      "built-in-throw",
      { signal },
    );
    const mcp = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: MCP_TOOL_NAME,
        tool_use_id: "mcp-throw",
        tool_input: { query: "inbox" },
      },
      "mcp-throw",
      { signal },
    );

    expect(builtin).toEqual(mcp);
    expect(builtin).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "broker.http_500",
      },
    });

    const denied = composeHarness(
      options({
        mcpServers: {
          [MCP_SERVER]: { transport: "http", url: "http://oikonomos.mcp.fake.local/fake" },
        },
        pretooluse: {
          handlePreToolUse: async (request) => denyHandle(request),
          dependencies: {},
        },
      }),
    );
    const denyHook = preToolUseHook(denied.harness);
    const builtinDeny = await denyHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "built-in-deny",
        tool_input: {},
      },
      "built-in-deny",
      { signal },
    );
    const mcpDeny = await denyHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: MCP_TOOL_NAME,
        tool_use_id: "mcp-deny",
        tool_input: {},
      },
      "mcp-deny",
      { signal },
    );
    expect(builtinDeny).toEqual(mcpDeny);
    expect(mcpDeny).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "capability.denied" },
    });
  });
});

describe("mcpServers config — no secret material in errors or logs (N4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("thrown config errors do not contain a supplied header or url value", () => {
    const invalid = {
      gmail: {
        transport: "http",
        url: SUPPLIED_URL,
        headers: { Authorization: SUPPLIED_HEADER, "X-Bad": 1 },
      },
    };

    expect(() => resolveMcpServers(invalid)).toThrow(McpConfigError);
    try {
      resolveMcpServers(invalid);
      expect.unreachable("invalid headers must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpConfigError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(SUPPLIED_URL);
      expect(message).not.toContain(SUPPLIED_HEADER);
      expect(message).not.toContain("NOT-A-REAL-SECRET");
      expect(JSON.stringify(err)).not.toContain(SUPPLIED_URL);
      expect(JSON.stringify(err)).not.toContain(SUPPLIED_HEADER);
    }

    try {
      composeHarness(
        options({
          mcpServers: {
            gmail: { transport: "http", url: "", headers: { Authorization: SUPPLIED_HEADER } },
          },
        }),
      );
      expect.unreachable("empty url must throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(SUPPLIED_HEADER);
      expect(message).not.toContain("NOT-A-REAL-SECRET");
    }
  });

  it("does not log the mcpServers record", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    composeHarness(
      options({
        mcpServers: {
          gmail: {
            transport: "http",
            url: SUPPLIED_URL,
            headers: { Authorization: SUPPLIED_HEADER },
          },
        },
      }),
    );

    for (const spy of [log, info, warn, error, debug]) {
      for (const args of spy.mock.calls) {
        const rendered = args.map((value) => JSON.stringify(value)).join(" ");
        expect(rendered).not.toContain(SUPPLIED_URL);
        expect(rendered).not.toContain(SUPPLIED_HEADER);
      }
    }
  });

  it("never reads process.env for MCP config", () => {
    for (const file of [...walkTs(join(srcRoot, "mcp")), join(srcRoot, "compose.ts")]) {
      const body = readFileSync(file, "utf8");
      expect(body, file).not.toContain("process.env");
    }
  });
});

describe("banned modes remain untouched", () => {
  it("mcp sources contain none of the banned permission-mode tokens", () => {
    for (const token of bannedModeTokens()) {
      expect(composeSource).not.toContain(token);
      for (const file of walkTs(join(srcRoot, "mcp"))) {
        expect(readFileSync(file, "utf8")).not.toContain(token);
      }
    }
  });
});
