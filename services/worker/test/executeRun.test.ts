import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CodexProvider, GrokProvider } from "@oikonomos/agent-providers";
import { L2_PERMISSION_MODE } from "@oikonomos/harness-factory";
import { describe, expect, it } from "vitest";

import { combineConnectorContexts } from "../src/chatRunDriver.js";
import { executeTaskRun, toScopedAllowedTool, WorkerExecutionError, type ConnectorContext } from "../src/executeRun.js";
import { createGatedSubprocessProviders } from "../src/subprocessProviders.js";

import {
  createCompletionSink,
  createDecisionLog,
  createFakeGmailMcp,
  createGmailBrokerDeps,
  createInboxTriageQueryFn,
  createWorkerBrokerDeps,
  GMAIL_DRAFT_TOOL,
  GMAIL_LIST_TOOL,
  GMAIL_SEND_TOOL,
  gmailConnectorContext,
  gmailDerivedAllowedTools,
  workerQueryFn,
  workerRun,
} from "./fixtures.js";

const executeSource = readFileSync(
  fileURLToPath(new URL("../src/executeRun.ts", import.meta.url)),
  "utf8",
);

describe("executeTaskRun — production caller", () => {
  it("imports composeHarness from the public package entry, not an ad-hoc path", () => {
    expect(executeSource).toContain('from "@oikonomos/harness-factory/compose"');
    expect(executeSource).toContain("composeHarness");
    expect(executeSource).toContain('from "@oikonomos/broker"');
    expect(executeSource).toContain("handlePreToolUse");
    expect(executeSource).not.toMatch(/createHarness\s*\(/);
    expect(executeSource).not.toContain("packages/harness-factory");
    expect(executeSource).not.toContain("@anthropic-ai/claude-agent-sdk");
  });

  it("invokes the agent through the composed harness (L1/L2/L3 bound)", async () => {
    const audit = createDecisionLog();
    const result = await executeTaskRun({
      prompt: "read the worker entry",
      run: workerRun,
      allowedTools: ["Read(src/**)"],
      brokerDependencies: createWorkerBrokerDeps(audit),
      auditSink: createCompletionSink(),
      queryFn: workerQueryFn,
    });

    expect(result.runtime.harness.config.permissionMode).toBe(L2_PERMISSION_MODE);
    expect(result.runtime.harness.invocation.hooks.PreToolUse).toHaveLength(1);
    expect(typeof result.runtime.harness.invocation.canUseTool).toBe("function");
    expect(result.events).toEqual([{ type: "result", toolUseId: "worker-e4-liveness-1" }]);
  });

  it("forwards caller-supplied Agent SDK process options through the composed harness", async () => {
    const captured: AgentSdkQueryInput[] = [];
    await executeTaskRun({
      prompt: "inspect the isolated workspace",
      run: workerRun,
      allowedTools: ["Read(src/**)"],
      brokerDependencies: createWorkerBrokerDeps(createDecisionLog()),
      auditSink: createCompletionSink(),
      agentSdkOptions: { cwd: "/isolated/run", env: {} },
      queryFn: async function* (input) { captured.push(input); },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.options).toMatchObject({ cwd: "/isolated/run", env: {} });
  });

  it("wires gated Codex/Grok providers from the production factory", async () => {
    const audit = createDecisionLog();
    const result = await executeTaskRun({
      prompt: "read the worker entry",
      run: workerRun,
      allowedTools: ["Read(src/**)"],
      brokerDependencies: createWorkerBrokerDeps(audit),
      auditSink: createCompletionSink(),
      queryFn: workerQueryFn,
      subprocessProviders: createGatedSubprocessProviders({
        codex: {
          bin: "C:\\oikonomos\\must-not-spawn-codex.exe",
          defaultModel: "gpt-5.4",
          sandbox: "read-only",
        },
        grok: {
          bin: "C:\\oikonomos\\must-not-spawn-grok.exe",
          defaultModel: "grok-4.5",
          sandbox: "read-only",
          alwaysApprove: true,
        },
        // TASK-143: `budget` is required unless explicitly opted out. No
        // production call site for this factory exists yet (tracked
        // separately), so this test — which only exercises provider
        // construction, not a real run — opts out explicitly rather than
        // fabricating a live DB-backed budget option.
        unsafeAllowUnbudgeted: true,
      }),
    });

    expect(result.runtime.providers.codex).toBeInstanceOf(CodexProvider);
    expect(result.runtime.providers.grok).toBeInstanceOf(GrokProvider);
  });

  it("requires a budget option or an explicit unsafeAllowUnbudgeted opt-out (TASK-143 liveness assertion)", () => {
    expect(() =>
      createGatedSubprocessProviders({
        codex: {
          bin: "C:\\oikonomos\\must-not-spawn-codex.exe",
          defaultModel: "gpt-5.4",
          sandbox: "read-only",
        },
        grok: {
          bin: "C:\\oikonomos\\must-not-spawn-grok.exe",
          defaultModel: "grok-4.5",
          sandbox: "read-only",
          alwaysApprove: true,
        },
      }),
    ).toThrow(/requires a `budget` option/);
  });

  it("rejects a park port that is not callable", async () => {
    await expect(
      executeTaskRun({
        prompt: "read the worker entry",
        run: workerRun,
        allowedTools: ["Read(src/**)"],
        brokerDependencies: createWorkerBrokerDeps(createDecisionLog()),
        auditSink: createCompletionSink(),
        park: { park: undefined as never },
      }),
    ).rejects.toBeInstanceOf(WorkerExecutionError);
  });

  it("accepts connector context and scopes derived MCP names for L2", async () => {
    expect(toScopedAllowedTool(GMAIL_LIST_TOOL)).toBe(`${GMAIL_LIST_TOOL}(*)`);
    expect(gmailDerivedAllowedTools).not.toContain(GMAIL_SEND_TOOL);

    const audit = createDecisionLog();
    const fake = createFakeGmailMcp();
    const capture: { mcpServers?: unknown } = {};
    const result = await executeTaskRun({
      prompt: "triage inbox",
      run: workerRun,
      allowedTools: ["Read(src/**)"],
      brokerDependencies: createGmailBrokerDeps(audit),
      auditSink: createCompletionSink(),
      queryFn: createInboxTriageQueryFn({ fake, capture }),
      connector: gmailConnectorContext(),
    });

    expect(result.connector).toEqual({ connectorIds: ["gmail"], mcpServerNames: ["gmail"] });
    expect(result.runtime.harness.config.allowedTools).toEqual([
      "Read(src/**)",
      `${GMAIL_LIST_TOOL}(*)`,
      `${GMAIL_DRAFT_TOOL}(*)`,
    ]);
    expect(Object.keys((capture.mcpServers as object) ?? {})).toEqual(["gmail"]);
  });

  it("reports every identity for a run mounting three connectors (TASK-146)", async () => {
    const context = (id: string): ConnectorContext => ({
      manifest: { connector_id: id, mcp_server: { name: id }, tools: [] },
      mcpServers: { [id]: { transport: "http", url: `http://${id}.fixture.invalid/mcp` } },
      allowedTools: [`mcp__${id}__list`],
    });
    const connector = combineConnectorContexts(
      context("gmail"),
      context("google-calendar"),
      context("google-drive"),
    );
    if (connector === undefined) throw new Error("TASK-146 expected a merged connector context");

    const result = await executeTaskRun({
      prompt: "inspect mounted connectors",
      run: workerRun,
      allowedTools: ["Read(src/**)"],
      brokerDependencies: createWorkerBrokerDeps(createDecisionLog()),
      auditSink: createCompletionSink(),
      queryFn: workerQueryFn,
      connector,
    });

    expect(result.connector).toEqual({
      connectorIds: ["gmail", "google-calendar", "google-drive"],
      mcpServerNames: ["gmail", "google-calendar", "google-drive"],
    });
  });

  it("passes mcpServers into composeHarness and nowhere else", () => {
    expect(executeSource).toContain("mcpServers: input.connector?.mcpServers");
    expect(executeSource).toContain("composeHarness");
    expect(executeSource).not.toContain("attachMcpServersToQuery");
  });
});
