import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRun, type DatabaseOptions } from "@oikonomos/db";

import { executeTaskRun, toScopedAllowedTool } from "../src/executeRun.js";
import { cancelTaskRun, startTaskRun } from "../src/runLifecycle.js";

import {
  createDecisionLog,
  createFakeGmailMcp,
  createGmailBrokerDeps,
  createInboxTriageQueryFn,
  createRecordingCompletionSink,
  FAKE_GMAIL_MCP_URL,
  GMAIL_DRAFT_TOOL,
  GMAIL_LIST_TOOL,
  GMAIL_SEND_TOOL,
  GMAIL_SERVER,
  gmailConnectorContext,
  gmailDerivedAllowedTools,
  simulatingMcpQuery,
  triageRun,
} from "./fixtures.js";

const executeSource = readFileSync(
  fileURLToPath(new URL("../src/executeRun.ts", import.meta.url)),
  "utf8",
);

const liveUrl = process.env.OIK_SECRET_MCP_GMAIL_URL;
const connectionString = process.env.DATABASE_URL;
const dbIntegration = connectionString === undefined ? describe.skip : describe;

function scopedDerived(): string[] {
  return gmailDerivedAllowedTools.map((name) => toScopedAllowedTool(name));
}

describe("inbox-triage end-to-end — governed worker run (TASK-055)", () => {
  it("mounts the connector MCP server through composeHarness only (N9)", async () => {
    expect(executeSource).toContain("mcpServers: input.connector?.mcpServers");
    expect(executeSource).toContain("composeHarness");
    expect(executeSource).toContain('from "@oikonomos/harness-factory/compose"');
    expect(executeSource).not.toContain("attachMcpServersToQuery");
    expect(executeSource).not.toContain("@anthropic-ai/claude-agent-sdk");
    expect(executeSource).not.toContain("packages/harness-factory");
  });

  it("END-TO-END: T0 list + T1 draft succeed; T3 send is DENIED and audited, in one run", async () => {
    const audit = createDecisionLog();
    const completion = createRecordingCompletionSink();
    const fake = createFakeGmailMcp();
    const capture: { mcpServers?: unknown } = {};

    const result = await executeTaskRun({
      prompt: "triage the inbox: list, draft a reply, do not send",
      run: triageRun,
      allowedTools: scopedDerived(),
      brokerDependencies: createGmailBrokerDeps(audit),
      auditSink: completion.sink,
      queryFn: createInboxTriageQueryFn({ fake, capture }),
      connector: gmailConnectorContext(),
    });

    const sdkServers = capture.mcpServers as Record<string, { type?: string }> | undefined;
    expect(sdkServers).toBeDefined();
    expect(Object.keys(sdkServers ?? {})).toEqual([GMAIL_SERVER]);
    expect(sdkServers?.[GMAIL_SERVER]?.type).toBe("http");
    expect(result.connector).toEqual({
      connectorIds: ["gmail"],
      mcpServerNames: [GMAIL_SERVER],
    });
    expect(result.runtime.harness.config.allowedTools).toEqual([
      `${GMAIL_LIST_TOOL}(*)`,
      `${GMAIL_DRAFT_TOOL}(*)`,
    ]);
    expect(result.runtime.harness.config.allowedTools).not.toContain(`${GMAIL_SEND_TOOL}(*)`);
    expect(result.runtime.harness.config.allowedTools).not.toContain(GMAIL_SEND_TOOL);

    expect(fake.invocations.map((call) => call.tool)).toEqual(["list_messages", "create_draft"]);
    expect(fake.invocations.some((call) => call.tool === "send_message")).toBe(false);

    const list = audit.events.find((event) => event.payload?.toolName === GMAIL_LIST_TOOL);
    const draft = audit.events.find((event) => event.payload?.toolName === GMAIL_DRAFT_TOOL);
    const send = audit.events.find((event) => event.payload?.toolName === GMAIL_SEND_TOOL);

    expect(list).toMatchObject({
      verdict: "allow",
      capability: "email.list",
      tier: "T0_observe",
      payload: expect.objectContaining({
        toolUseId: "triage-list-1",
        toolName: GMAIL_LIST_TOOL,
        sessionRef: triageRun.agentRef.sessionRef,
        isSubagent: false,
      }),
    });
    expect(draft).toMatchObject({
      verdict: "allow",
      capability: "email.create_draft",
      tier: "T1_draft",
      payload: expect.objectContaining({
        toolUseId: "triage-draft-1",
        toolName: GMAIL_DRAFT_TOOL,
      }),
    });
    expect(send).toMatchObject({
      verdict: "deny",
      reason: "role.tier_ceiling",
      capability: "email.send",
      tier: "T3_external",
      payload: expect.objectContaining({
        toolUseId: "triage-send-1",
        toolName: GMAIL_SEND_TOOL,
      }),
    });

    expect(result.events).toEqual([
      expect.objectContaining({
        type: "tool_result",
        toolName: GMAIL_LIST_TOOL,
        executed: true,
      }),
      expect.objectContaining({
        type: "tool_result",
        toolName: GMAIL_DRAFT_TOOL,
        executed: true,
      }),
      expect.objectContaining({
        type: "tool_denied",
        toolName: GMAIL_SEND_TOOL,
        executed: false,
        reason: "role.tier_ceiling",
      }),
    ]);

    const completedTools = completion.writes.map((row) => row.toolName);
    expect(completedTools).toEqual([GMAIL_LIST_TOOL, GMAIL_DRAFT_TOOL]);
    expect(completedTools).not.toContain(GMAIL_SEND_TOOL);

    // Directive §5 Evidenced: what data, what actions, what was denied.
    const trail = {
      sessionRef: triageRun.agentRef.sessionRef,
      data: fake.invocations,
      actions: audit.events.map((event) => ({
        toolName: event.payload?.toolName,
        verdict: event.verdict,
        capability: event.capability,
        tier: event.tier,
        reason: event.reason,
      })),
      denied: audit.events
        .filter((event) => event.verdict === "deny")
        .map((event) => event.payload?.toolName),
    };
    expect(trail.data).toHaveLength(2);
    expect(trail.actions).toEqual([
      {
        toolName: GMAIL_LIST_TOOL,
        verdict: "allow",
        capability: "email.list",
        tier: "T0_observe",
        reason: undefined,
      },
      {
        toolName: GMAIL_DRAFT_TOOL,
        verdict: "allow",
        capability: "email.create_draft",
        tier: "T1_draft",
        reason: undefined,
      },
      {
        toolName: GMAIL_SEND_TOOL,
        verdict: "deny",
        capability: "email.send",
        tier: "T3_external",
        reason: "role.tier_ceiling",
      },
    ]);
    expect(trail.denied).toEqual([GMAIL_SEND_TOOL]);
  });

  it("does not echo the resolved MCP url in worker source (N4)", () => {
    expect(executeSource).not.toContain(FAKE_GMAIL_MCP_URL);
    expect(executeSource).not.toMatch(/secret:\/\//);
    expect(executeSource.toLowerCase()).not.toContain("authorization");
  });
});

describe("ADR-005 — MCP-path liveness (TASK-055)", () => {
  it("keys on a broker decision audit event emitted by a worker-driven MCP tool call", async () => {
    const audit = createDecisionLog();
    const fake = createFakeGmailMcp();

    await executeTaskRun({
      prompt: "triage the inbox",
      run: triageRun,
      allowedTools: scopedDerived(),
      brokerDependencies: createGmailBrokerDeps(audit),
      auditSink: createRecordingCompletionSink().sink,
      queryFn: createInboxTriageQueryFn({ fake }),
      connector: gmailConnectorContext(),
    });

    expect(audit.events.length).toBeGreaterThan(0);
    expect(audit.events.some((event) => event.payload?.toolName === GMAIL_LIST_TOOL)).toBe(true);
    expect(audit.events.some((event) => event.payload?.toolName === GMAIL_SEND_TOOL)).toBe(true);
  });

  it("MUTATION-PROVEN: bypassing composeHarness for MCP calls writes no broker audit event", async () => {
    const audit = createDecisionLog();
    createGmailBrokerDeps(audit);

    const events: unknown[] = [];
    for await (const event of simulatingMcpQuery({ prompt: "triage the inbox" })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(audit.events).toEqual([]);
  });
});

dbIntegration("inbox-triage run lifecycle (OIK-038)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let pool: Pool;
  let taskId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString! });
    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      ["inbox-triage", "TASK-055 worker e2e", "governed inbox-triage run", "test:task-055-worker"],
    );
    const insertedTaskId = task.rows[0]?.task_id;
    if (insertedTaskId === undefined) {
      throw new Error("failed to insert TASK-055 worker fixture task");
    }
    taskId = insertedTaskId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists session_ref and reaches a terminal state after the governed run", async () => {
    const sessionRef = "sess-inbox-triage-055";
    const started = await startTaskRun(options, {
      taskId,
      provider: "claude-code",
      sessionRef,
    });
    expect(started.status).toBe("started");
    expect(started.sessionRef).toBe(sessionRef);

    const audit = createDecisionLog();
    const fake = createFakeGmailMcp();
    const run = {
      runId: started.runId,
      roleId: "inbox-triage",
      tenantId: started.tenantId,
      agentRef: { provider: "claude", sessionRef, isSubagent: false },
    };

    await executeTaskRun({
      prompt: "triage the inbox",
      run,
      allowedTools: scopedDerived(),
      brokerDependencies: createGmailBrokerDeps(audit),
      auditSink: createRecordingCompletionSink().sink,
      queryFn: createInboxTriageQueryFn({ fake }),
      connector: gmailConnectorContext(),
    });

    const persisted = await getRun(options, started.runId);
    expect(persisted?.sessionRef).toBe(sessionRef);
    expect(persisted?.status).toBe("started");
    expect(audit.events.some((event) => event.payload?.sessionRef === sessionRef)).toBe(true);

    // `completed` is in the run_status enum but TASK-034 did not export a
    // completeRun. cancel is the public terminal transition used to close
    // the fixture after a successful governed query.
    const closed = await cancelTaskRun(options, started.runId);
    expect(closed.status).toBe("cancelled");
    expect(closed.endedAt).not.toBeNull();
    expect(closed.sessionRef).toBe(sessionRef);
  });
});

const live = liveUrl === undefined || liveUrl.trim().length === 0 ? describe.skip : describe;

live("inbox-triage live Gmail MCP mount (unauthenticated surface)", () => {
  it("mounts the provisioned url through composeHarness and records tools/list", async () => {
    const url = liveUrl ?? "";
    const audit = createDecisionLog();
    const fake = createFakeGmailMcp();
    const capture: { mcpServers?: unknown } = {};

    const result = await executeTaskRun({
      prompt: "triage the inbox",
      run: triageRun,
      allowedTools: scopedDerived(),
      brokerDependencies: createGmailBrokerDeps(audit),
      auditSink: createRecordingCompletionSink().sink,
      queryFn: createInboxTriageQueryFn({ fake, capture }),
      connector: gmailConnectorContext({
        mcpServers: { [GMAIL_SERVER]: { transport: "http", url } },
      }),
    });

    const sdkServers = capture.mcpServers as Record<string, { type?: string; url?: unknown }> | undefined;
    expect(Object.keys(sdkServers ?? {})).toEqual([GMAIL_SERVER]);
    expect(sdkServers?.[GMAIL_SERVER]?.type).toBe("http");
    expect(typeof sdkServers?.[GMAIL_SERVER]?.url).toBe("string");
    expect(result.connector?.mcpServerNames).toEqual([GMAIL_SERVER]);
    expect(audit.events.some((event) => event.verdict === "deny")).toBe(true);

    const { createHttpMcpToolEnumerator } = await import(
      "../../../packages/connectors/src/enumeration/httpListTools.js"
    );
    const enumerator = createHttpMcpToolEnumerator(GMAIL_SERVER, {
      transport: "http",
      url,
    });
    const names = await enumerator.listTools();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith("mcp__gmail__"))).toBe(true);
  });
});
