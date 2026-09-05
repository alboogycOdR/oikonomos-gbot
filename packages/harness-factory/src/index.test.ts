import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSync, sdkQuery } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  sdkQuery: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdkQuery }));

import { createHarness, L2_PERMISSION_MODE, type AgentSdkQueryInput } from "./index.js";

const SYSTEM_CLAUDE = process.platform === "win32" ? "C:\\Tools\\claude.exe" : "/usr/local/bin/claude";

function createDefaultHarness() {
  return createHarness({
    l1: { async handle() { return { decision: "allow" as const }; } },
    l2: { permissionMode: L2_PERMISSION_MODE, allowedTools: [] },
    l3: { async canUseTool(request) { return { behavior: "allow" as const, updatedInput: request.input }; } },
  });
}

async function invokeDefaultQuery(options?: Record<string, unknown>): Promise<AgentSdkQueryInput> {
  const captured: AgentSdkQueryInput[] = [];
  sdkQuery.mockImplementation((input: AgentSdkQueryInput) => {
    captured.push(input);
    return (async function* () {})();
  });

  for await (const _ of createDefaultHarness().query({ prompt: "test", options })) {
    void _;
  }

  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe("defaultSdkQuery system Claude resolution", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("adds a resolved system executable when the caller did not set one", async () => {
    execFileSync.mockReturnValue(`${SYSTEM_CLAUDE}\n`);

    const input = await invokeDefaultQuery({ cwd: "/workspace" });

    expect(execFileSync).toHaveBeenCalledWith(
      process.platform === "win32" ? "where" : "which",
      ["claude"],
      { encoding: "utf8", windowsHide: true },
    );
    expect(input.options).toMatchObject({
      cwd: "/workspace",
      pathToClaudeCodeExecutable: SYSTEM_CLAUDE,
    });
  });

  it("uses strict MCP configuration for a governed system-CLI invocation", async () => {
    execFileSync.mockReturnValue(`${SYSTEM_CLAUDE}\n`);

    const input = await invokeDefaultQuery({
      cwd: "/isolated/chat-run",
      env: {},
      mcpServers: { oikonomos: { type: "http", url: "https://connector.invalid/mcp" } },
    });

    // `strictMcpConfig` maps to the CLI's --strict-mcp-config flag: it keeps
    // this explicit server map while excluding user, project, and plugin MCP
    // configuration. Removing the production guard makes this test fail.
    expect(input.options).toMatchObject({
      cwd: "/isolated/chat-run",
      env: {},
      mcpServers: { oikonomos: { type: "http", url: "https://connector.invalid/mcp" } },
      pathToClaudeCodeExecutable: SYSTEM_CLAUDE,
      strictMcpConfig: true,
    });
  });

  it("never overwrites a caller-supplied executable", async () => {
    const callerExecutable = "/caller/claude";

    const input = await invokeDefaultQuery({ pathToClaudeCodeExecutable: callerExecutable });

    expect(execFileSync).not.toHaveBeenCalled();
    expect(input.options).toMatchObject({ pathToClaudeCodeExecutable: callerExecutable });
  });

  it("falls through to the SDK default when no binary is found", async () => {
    execFileSync.mockReturnValue("\n  \n");

    const input = await invokeDefaultQuery();

    expect(input.options).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("falls through to the SDK default when resolution throws", async () => {
    execFileSync.mockImplementation(() => {
      throw new Error("claude is unavailable");
    });

    const input = await invokeDefaultQuery();

    expect(input.options).not.toHaveProperty("pathToClaudeCodeExecutable");
  });
});
