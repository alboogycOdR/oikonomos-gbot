import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CodexProvider, GrokProvider } from "@oikonomos/agent-providers";
import { L2_PERMISSION_MODE } from "@oikonomos/harness-factory";
import { describe, expect, it } from "vitest";

import { executeTaskRun, toScopedAllowedTool, WorkerExecutionError } from "../src/executeRun.js";
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
      }),
    });

    expect(result.runtime.providers.codex).toBeInstanceOf(CodexProvider);
    expect(result.runtime.providers.grok).toBeInstanceOf(GrokProvider);
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

    expect(result.connector).toEqual({ connectorId: "gmail", mcpServerNames: ["gmail"] });
    expect(result.runtime.harness.config.allowedTools).toEqual([
      "Read(src/**)",
      `${GMAIL_LIST_TOOL}(*)`,
      `${GMAIL_DRAFT_TOOL}(*)`,
    ]);
    expect(Object.keys((capture.mcpServers as object) ?? {})).toEqual(["gmail"]);
  });

  it("passes mcpServers into composeHarness and nowhere else", () => {
    expect(executeSource).toContain("mcpServers: input.connector?.mcpServers");
    expect(executeSource).toContain("composeHarness");
    expect(executeSource).not.toContain("attachMcpServersToQuery");
  });
});
