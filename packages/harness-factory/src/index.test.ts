import { readFileSync } from "node:fs";

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

describe("defaultSdkQuery host model pin", () => {
  const originalHostModel = process.env.OIKONOMOS_HOST_MODEL;

  afterEach(() => {
    vi.clearAllMocks();
    if (originalHostModel === undefined) {
      delete process.env.OIKONOMOS_HOST_MODEL;
    } else {
      process.env.OIKONOMOS_HOST_MODEL = originalHostModel;
    }
  });

  it("uses the cheap default when the caller did not set options.model", async () => {
    delete process.env.OIKONOMOS_HOST_MODEL;
    execFileSync.mockReturnValue(`${SYSTEM_CLAUDE}\n`);

    const input = await invokeDefaultQuery({ cwd: "/workspace" });

    expect(input.options).toMatchObject({ model: "claude-haiku-4-5-20251001" });
  });

  it("never overwrites a caller-supplied options.model", async () => {
    delete process.env.OIKONOMOS_HOST_MODEL;
    const callerModel = "claude-opus-4-8";

    const input = await invokeDefaultQuery({ model: callerModel });

    expect(input.options).toMatchObject({ model: callerModel });
  });

  it("still pins the cheap default when the caller supplied an executable", async () => {
    delete process.env.OIKONOMOS_HOST_MODEL;
    const callerExecutable = "/caller/claude";

    const input = await invokeDefaultQuery({ pathToClaudeCodeExecutable: callerExecutable });

    expect(execFileSync).not.toHaveBeenCalled();
    expect(input.options).toMatchObject({
      pathToClaudeCodeExecutable: callerExecutable,
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("honors an OIKONOMOS_HOST_MODEL override instead of the cheap default", async () => {
    process.env.OIKONOMOS_HOST_MODEL = "claude-sonnet-5";

    const input = await invokeDefaultQuery();

    expect(input.options).toMatchObject({ model: "claude-sonnet-5" });
  });

  it("does not let OIKONOMOS_HOST_MODEL override an explicit caller model", async () => {
    process.env.OIKONOMOS_HOST_MODEL = "claude-sonnet-5";

    const input = await invokeDefaultQuery({ model: "claude-opus-4-8" });

    expect(input.options).toMatchObject({ model: "claude-opus-4-8" });
  });

  it("treats a whitespace-only OIKONOMOS_HOST_MODEL as unset", async () => {
    process.env.OIKONOMOS_HOST_MODEL = "   ";

    const input = await invokeDefaultQuery();

    expect(input.options).toMatchObject({ model: "claude-haiku-4-5-20251001" });
  });

  it("documents OIKONOMOS_HOST_MODEL against CLAUDE.md Budget", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("OIKONOMOS_HOST_MODEL");
    expect(source).toContain("CLAUDE.md");
    expect(source).toContain("Budget");
  });
});
