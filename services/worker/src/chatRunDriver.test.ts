import {
  Database,
  createRole,
  createTask,
  defaultPoolConfig,
  getAuditEventsForRun,
  getOrCreateThreadForRole,
  listMessages,
  listRuns,
  type DatabaseOptions,
} from "@oikonomos/db";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSdkQueryFn, AgentSdkQueryInput } from "@oikonomos/harness-factory";
import { defaultManifestsDir, loadManifests, type ConnectorManifest } from "@oikonomos/connectors";

import {
  CHAT_FANOUT_CAPABILITY_ID,
  combineConnectorContexts,
  createChatRunDriver,
  deliverBotToBotMessage,
  destinationFor,
  finalText,
} from "./chatRunDriver.js";
import { parkTaskRun, reconcileInterruptedRuns, startTaskRun } from "./runLifecycle.js";
import { handleWorkspaceMcpRequest } from "./workspaceMcpServer.js";
import type { ConnectorContext } from "./executeRun.js";

const chatRunDriverSource = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("./chatRunDriver.ts", import.meta.url), "utf8"),
);
const execFileAsync = promisify(execFile);

const base = {
  toolUseId: "tool-use", runId: "11111111-1111-1111-1111-111111111111", roleId: "chat-bot", tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "session", isSubagent: false },
};

const task128Manifest: ConnectorManifest = {
  connector_id: "gmail",
  account_ownership: "basileia",
  mcp_server: { name: "gmail", transport: "remote", url_ref: "secret://mcp/gmail/url" },
  tools: [
    { tool_name: "mcp__gmail__list_messages", capability_id: "email.list", default_tier: "T0_observe" },
    { tool_name: "mcp__gmail__create_draft", capability_id: "email.create_draft", default_tier: "T1_draft" },
    { tool_name: "mcp__gmail__send_message", capability_id: "email.send", default_tier: "T3_external" },
  ],
  role_grants: [],
  evals: { suite: "evals/golden/suites/task-128", min_pass_rate: 0.9 },
  review: { onboarded_by: "test", date: "2026-09-04", scope_justification: "TASK-128 fixture" },
};

async function callMountedTool(
  input: AgentSdkQueryInput,
  toolName: string,
  toolUseId: string,
  toolInput: Record<string, unknown>,
): Promise<boolean> {
  const options = input.options as {
    hooks?: { PreToolUse?: Array<{ hooks: Array<(...args: never[]) => Promise<unknown>> }> };
  } | undefined;
  const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
  if (hook === undefined) throw new Error("TASK-128 fixture expected the composed PreToolUse hook");
  const output = await hook(
    { hook_event_name: "PreToolUse", tool_name: toolName, tool_use_id: toolUseId, tool_input: toolInput } as never,
    toolUseId as never,
    { signal: new AbortController().signal } as never,
  ) as { hookSpecificOutput?: { permissionDecision?: string } };
  return output.hookSpecificOutput?.permissionDecision === "allow";
}

async function readRequest(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("chat run driver governance helpers", () => {
  it("merges zero, one, two, and four connector contexts without pairwise limits (TASK-139)", () => {
    const context = (id: string): ConnectorContext => ({
      manifest: { connector_id: id, mcp_server: { name: id }, tools: [] },
      mcpServers: { [id]: { transport: "http", url: `http://${id}.fixture.invalid/mcp` } },
      allowedTools: [`mcp__${id}__list`],
    });
    const [gmail, workspace, calendar, drive] = ["gmail", "workspace", "google-calendar", "google-drive"].map(context);
    expect(combineConnectorContexts()).toBeUndefined();
    expect(combineConnectorContexts(gmail)).toMatchObject({ allowedTools: ["mcp__gmail__list"], mcpServers: { gmail: expect.anything() } });
    expect(combineConnectorContexts(gmail, workspace)).toMatchObject({ allowedTools: ["mcp__gmail__list", "mcp__workspace__list"] });
    expect(combineConnectorContexts(gmail, workspace, calendar, drive)).toMatchObject({
      connectorIds: ["gmail", "workspace", "google-calendar", "google-drive"],
      allowedTools: ["mcp__gmail__list", "mcp__workspace__list", "mcp__google-calendar__list", "mcp__google-drive__list"],
      mcpServers: { gmail: expect.anything(), workspace: expect.anything(), "google-calendar": expect.anything(), "google-drive": expect.anything() },
    });
  });

  it("uses the scoped built-in mount while leaving Agent SDK query ownership to harness-factory", () => {
    expect(chatRunDriverSource).toContain('allowedTools: ["Bash(*)", "Read(*)"]');
    // TASK-128 has an injected query seam for its protocol-compatible MCP
    // fixture; production still leaves Agent SDK ownership with the factory.
    expect(chatRunDriverSource).toContain("options.queryFn");
    expect(chatRunDriverSource).not.toContain("@anthropic-ai/claude-agent-sdk");
  });

  it("derives Gmail's mounted surface from persisted, enabled grants only (TASK-128)", () => {
    // This is deliberately tied to the per-run filter rather than merely the
    // broker's later tier check: deleting it would mount every Gmail manifest
    // tool (including ungranted email.send) and makes this test red.
    expect(chatRunDriverSource).toContain("database.listRoleGrants(input.roleId)");
    expect(chatRunDriverSource).toContain("tool.enabled !== false && grantedCapabilities.has(tool.capability_id)");
    expect(chatRunDriverSource).toContain("connector: { manifest, mcpServers: handle.mcpServers, allowedTools }");
    expect(chatRunDriverSource).toContain("mint: createGmailConnectorSessionMinter");
    expect(chatRunDriverSource).toContain("connector?.allowedTools");
  });

  it("derives only ADR-013's approved destinations and fails closed otherwise", () => {
    expect(destinationFor({ ...base, toolName: "Read", input: { file_path: "src/app.ts" } })).toBe("src/app.ts");
    expect(destinationFor({ ...base, toolName: "Glob", input: { pattern: "src/**/*.ts" } })).toBe("src/**/*.ts");
    expect(destinationFor({ ...base, toolName: "Bash", input: { command: "git status" } })).toBe("git status");
    expect(destinationFor({ ...base, toolName: "mcp__gmail__send_message", input: { to: "user@example.test" } })).toBe("user@example.test");
    expect(() => destinationFor({ ...base, toolName: "WebFetch", input: { url: "https://example.test" } })).toThrow(/No governed destination/);
  });

  it("uses the final SDK result while keeping a non-empty fallback reply", () => {
    expect(finalText([{ result: "first" }, { type: "progress" }, { result: " final reply " }])).toBe("final reply");
    expect(finalText([{ type: "progress" }])).toMatch(/completed/);
  });
});

// TASK-116: closes the gap flagged in TASK-111's own Review_Findings — the
// live governed-execution claim was independently verified by ORCH against
// real production Postgres, but nothing here would catch a future
// regression. This drives `createChatRunDriver(...).run(...)` for real: a
// real Postgres task/thread, a real Claude Agent SDK call (real inference
// spend — see the dossier for actual cost), and real assertions against
// Postgres afterward. Zero-grant deny path (ADR-013 §7's own suggested
// alternative to seeding a grant): a freshly created role_id has no
// `role_grants` row, so the broker's `role.grant_missing` deny fires the
// instant the model attempts its one Bash call — a real `policy.decision`
// audit event for `runtime.bash`/`T3_external`, same evidentiary bar as
// CAN-09, without needing to seed a grant or drive the approval-pending
// park path (already covered by TASK-111's own live verification note).
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("createChatRunDriver — real governed chat run (TASK-116)", () => {
  let pool: Pool;
  let options: DatabaseOptions;
  const roleId = "task-116-chat-run-driver-suite";
  let task: Awaited<ReturnType<typeof createTask>>;
  let taskId: string;
  let threadId: string;
  const previousCapabilitiesEnabled = process.env.OIKONOMOS_CAPABILITIES_ENABLED;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))`,
      [roleId],
    );
    // TASK-136 added a real pending-approval fixture — `approvals.run_id`
    // FK-references `runs`, so it must be deleted before `runs` below or the
    // DELETE violates `approvals_run_id_fkey`.
    await pool.query(
      `DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))`,
      [roleId],
    );
    await pool.query(
      `DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)`,
      [roleId],
    );
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`,
      [roleId],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
    // TASK-120 added thread_members (FK to threads); this cleanup predates
    // that table and must delete from it first or the threads DELETE below
    // violates thread_members_thread_id_fkey. A stray pre-TASK-120 thread
    // left by an interrupted run got picked up by TASK-120's own one-time
    // migration backfill, which is exactly how this surfaced for real.
    await pool.query(`DELETE FROM thread_members WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM threads WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM role_grants WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM roles WHERE role_id = $1`, [roleId]);
  }

  beforeAll(async () => {
    // isCapabilitiesEnabled() reads this per-call (ADR-013's suggested v1) —
    // without it the broker denies at "capability.disabled" before ever
    // reaching getCapability/getRoleGrant, which would prove nothing about
    // ADR-013 §7's grant path.
    process.env.OIKONOMOS_CAPABILITIES_ENABLED = "true";
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();

    // Deliberately zero role_grants for this role: the test exercises
    // ADR-013 §7's zero-grant deny path, not the seeded-grant path.
    await createRole(options, {
      roleId,
      name: roleId,
      title: "TASK-116 governed chat run fixture role",
      description: "TASK-116 chatRunDriver integration fixture — intentionally grant-less.",
    });
    // Keep the shared development capability rows aligned to the checked-in
    // Gmail manifest. This is idempotent fixture setup, not a new capability.
    const database = new Database(options);
    try {
      await database.upsertCapability({ capabilityId: "email.list", description: "List Gmail messages.", defaultTier: "T0_observe", adapter: "mcp:gmail", enabled: true });
      await database.upsertCapability({ capabilityId: "email.create_draft", description: "Create a Gmail draft.", defaultTier: "T1_draft", adapter: "mcp:gmail", enabled: true });
      await database.upsertCapability({ capabilityId: "email.send", description: "Send a Gmail message.", defaultTier: "T3_external", adapter: "mcp:gmail", enabled: false });
    } finally {
      await database.close();
    }

    task = await createTask(options, {
      roleId,
      title: "TASK-116 governed chat run fixture",
      goal: "Run `pwd` via Bash exactly once, then stop.",
      requestedBy: "task-116-suite",
    });
    taskId = task.taskId;

    const thread = await pool.query<{ id: string }>(
      "INSERT INTO threads (role_id) VALUES ($1) RETURNING id",
      [roleId],
    );
    threadId = thread.rows[0]!.id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    if (previousCapabilitiesEnabled === undefined) delete process.env.OIKONOMOS_CAPABILITIES_ENABLED;
    else process.env.OIKONOMOS_CAPABILITIES_ENABLED = previousCapabilitiesEnabled;
  });

  it(
    "drives a real chat run end-to-end: policy.decision audit event, a bot reply, and a completed run",
    async () => {
      const driver = createChatRunDriver(options);

      await driver.run({ task, threadId });

      const runsPage = await listRuns(options, { taskId });
      expect(runsPage.runs).toHaveLength(1);
      const run = runsPage.runs[0]!;
      expect(run.status).toBe("completed");
      expect(run.endedAt).not.toBeNull();

      const events = await getAuditEventsForRun(options, run.runId);
      const decision = events.find((event) => event.eventType === "policy.decision" && event.capability === "runtime.bash");
      expect(decision).toBeDefined();
      expect(decision?.tier).toBe("T3_external");
      // Zero role_grants ⇒ ADR-013 §7's role.grant_missing deny reason,
      // fired before any tier-ceiling/approval logic is even reached.
      expect(decision?.payload).toMatchObject({ toolName: "Bash", reason: "role.grant_missing", verdict: "deny" });

      const messages = await listMessages(options, threadId);
      const botMessage = messages.find((message) => message.role === "bot" && message.runId === run.runId);
      expect(botMessage).toBeDefined();
      expect(botMessage?.body.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it("continues a real parked run with its persisted SDK session and appends the continuation on the same thread (TASK-155)", async () => {
    const resumeTask = await createTask(options, {
      roleId,
      title: "TASK-155 resume fixture",
      goal: "Continue after human approval.",
      requestedBy: `chat:thread:${threadId}`,
    });
    const sessionRef = "15555555-5555-4555-8555-555555555555";
    const parked = await startTaskRun(options, { taskId: resumeTask.taskId, provider: "claude", tenantId: resumeTask.tenantId, sessionRef });
    await parkTaskRun(options, parked.runId);
    let observedResume: unknown;
    const queryFn: AgentSdkQueryFn = async function* (input) {
      observedResume = (input.options as { resume?: unknown }).resume;
      yield { type: "result", result: "Approval granted; the original SDK session continued." };
    };

    await createChatRunDriver({ ...options, queryFn }).run({
      task: resumeTask,
      threadId,
      resume: { runId: parked.runId, sessionRef },
    });

    expect(observedResume).toBe(sessionRef);
    const run = (await listRuns(options, { taskId: resumeTask.taskId })).runs[0]!;
    expect(run).toMatchObject({ runId: parked.runId, status: "completed", sessionRef });
    const messages = await listMessages(options, threadId);
    expect(messages.find((message) => message.runId === parked.runId)?.body).toBe("Approval granted; the original SDK session continued.");
  });

  it("builds a system prompt from the persisted role identity and custom instructions (TASK-156)", async () => {
    const instructions = "Always introduce yourself as the Northstar analyst.";
    await pool.query(
      `UPDATE roles SET name = $2, title = $3, description = $4, instructions = $5 WHERE role_id = $1`,
      [roleId, "Northstar", "Market Analyst", "Explains market movements with sources.", instructions],
    );
    const personaTask = await createTask(options, {
      roleId,
      title: "TASK-156 persona fixture",
      goal: "Say hello.",
      requestedBy: "task-156-suite",
    });
    let observedSystemPrompt: unknown;
    const queryFn: AgentSdkQueryFn = async function* (input) {
      observedSystemPrompt = (input.options as { systemPrompt?: unknown }).systemPrompt;
      yield { type: "result", result: "Northstar is ready." };
    };

    await createChatRunDriver({ ...options, queryFn }).run({ task: personaTask, threadId });

    expect(observedSystemPrompt).toContain("Northstar");
    expect(observedSystemPrompt).toContain("Market Analyst");
    expect(observedSystemPrompt).toContain("Explains market movements with sources.");
    expect(observedSystemPrompt).toContain(instructions);
  });

  it("uses a non-empty default identity prompt when role instructions are unset (TASK-156)", async () => {
    await pool.query(`UPDATE roles SET instructions = NULL WHERE role_id = $1`, [roleId]);
    const defaultPromptTask = await createTask(options, {
      roleId,
      title: "TASK-156 default persona fixture",
      goal: "Say hello without custom instructions.",
      requestedBy: "task-156-suite",
    });
    let observedSystemPrompt: unknown;
    const queryFn: AgentSdkQueryFn = async function* (input) {
      observedSystemPrompt = (input.options as { systemPrompt?: unknown }).systemPrompt;
      yield { type: "result", result: "Default identity is ready." };
    };

    await createChatRunDriver({ ...options, queryFn }).run({ task: defaultPromptTask, threadId });

    expect(observedSystemPrompt).toContain("Northstar");
    expect(observedSystemPrompt).toContain("Market Analyst");
    expect(observedSystemPrompt).toContain("Explains market movements with sources.");
    expect(observedSystemPrompt).toMatch(/\S/);
    expect(observedSystemPrompt).not.toContain("Your custom instructions:");
  });

  it("fails a parked run cleanly when its SDK continuation fails, without fabricating a bot response (TASK-155)", async () => {
    const resumeTask = await createTask(options, {
      roleId,
      title: "TASK-155 failed resume fixture",
      goal: "This resumed SDK call deliberately fails.",
      requestedBy: `chat:thread:${threadId}`,
    });
    const sessionRef = "15555555-5555-4555-8555-555555555556";
    const parked = await startTaskRun(options, { taskId: resumeTask.taskId, provider: "claude", tenantId: resumeTask.tenantId, sessionRef });
    await parkTaskRun(options, parked.runId);
    const queryFn: AgentSdkQueryFn = async function* () {
      throw new Error("SDK session expired");
    };

    await expect(createChatRunDriver({ ...options, queryFn }).run({
      task: resumeTask,
      threadId,
      resume: { runId: parked.runId, sessionRef },
    })).rejects.toThrow("SDK session expired");

    const run = (await listRuns(options, { taskId: resumeTask.taskId })).runs[0]!;
    expect(run).toMatchObject({ runId: parked.runId, status: "failed", failureNote: "SDK session expired" });
    expect((await listMessages(options, threadId)).some((message) => message.runId === parked.runId)).toBe(false);
  });

  it(
    "runs Bash in a fresh workspace with an empty environment and removes it afterward (TASK-153)",
    async () => {
      const secretName = "TASK_153_TEST_PROCESS_SECRET";
      const secretValue = `injected-${Date.now()}`;
      const previousSecret = process.env[secretName];
      process.env[secretName] = secretValue;
      let workspace: string | undefined;
      try {
        const isolationTask = await createTask(options, {
          roleId,
          title: "TASK-153 workspace isolation fixture",
          goal: "Exercise the chat workspace boundary.",
          requestedBy: "task-153-suite",
        });
        const queryFn: AgentSdkQueryFn = async function* (input) {
          const sdkOptions = input.options as { cwd?: string; env?: Record<string, string> };
          workspace = sdkOptions.cwd;
          expect(workspace).toBeTruthy();
          expect(sdkOptions.env).toEqual({});
          // This is the driver-to-SDK seam: execute the same real shell a
          // Bash tool would receive, using the exact cwd/env it was given.
          const shell = process.platform === "win32" ? "bash.exe" : "bash";
          const { stdout } = await execFileAsync(shell, ["-lc", `pwd; printf '\\n%s' \"$${secretName}\"`], {
            cwd: workspace,
            env: sdkOptions.env,
          });
          const [reportedCwd, reportedSecret] = stdout.trimEnd().split(/\r?\n/, 2);
          if (process.platform === "win32") expect(reportedCwd).toContain("oikonomos-chat-");
          else expect(reportedCwd).toBe(workspace);
          expect(reportedSecret ?? "").not.toBe(secretValue);
          yield { type: "result", result: "workspace isolation verified" };
        };

        await createChatRunDriver({ ...options, queryFn }).run({ task: isolationTask, threadId });
      } finally {
        if (previousSecret === undefined) delete process.env[secretName];
        else process.env[secretName] = previousSecret;
      }
      expect(workspace).toBeDefined();
      await expect(access(workspace!)).rejects.toThrow();
    },
    120_000,
  );

  it(
    "completes a real mounted Read action with its T0 role grant and no pending approval",
    async () => {
      const database = new Database(options);
      try {
        await database.upsertRoleGrant({
          roleId,
          capabilityId: "fs.read",
          maxTier: "T0_observe",
          constraints: {},
        });
      } finally {
        await database.close();
      }
      const readTask = await createTask(options, {
        roleId,
        title: "TASK-117 T0 Read grant fixture",
        goal: "Use Read to read package.json exactly once. Do not use Bash or any other tool, then report the package name.",
        requestedBy: "task-117-suite",
      });

      await createChatRunDriver(options).run({ task: readTask, threadId });

      const runsPage = await listRuns(options, { taskId: readTask.taskId });
      const run = runsPage.runs[0]!;
      expect(run.status).toBe("completed");
      const events = await getAuditEventsForRun(options, run.runId);
      expect(events.find((event) => event.eventType === "policy.decision" && event.capability === "fs.read"))
        .toMatchObject({ tier: "T0_observe", payload: { toolName: "Read", verdict: "allow" } });
      const approvals = await pool.query<{ count: string }>(
        "SELECT count(*) FROM approvals WHERE run_id = $1 AND status = 'pending'",
        [run.runId],
      );
      expect(approvals.rows[0]!.count).toBe("0");
    },
    120_000,
  );

  it(
    "a real pending approval during a chat run actually parks it to waiting_approval, and reconcileInterruptedRuns closes the loop (TASK-136)",
    async () => {
      // email.send is declared T3_external by task128Manifest itself — this
      // deliberately reuses the manifest's own declared tier rather than
      // picking an arbitrary one, so CapabilityRegistry's tier-drift guard
      // (C5) cannot silently paper over a mismatch. T3_external is >=
      // APPROVAL_TIER (packages/broker), so a granted call to it issues a
      // real pending approval instead of an outright deny or a bare allow.
      const database = new Database(options);
      try {
        await database.upsertCapability({
          capabilityId: "email.send",
          description: "Send a Gmail message.",
          defaultTier: "T3_external",
          adapter: "mcp:gmail",
          enabled: true,
        });
        await database.upsertRoleGrant({ roleId, capabilityId: "email.send", maxTier: "T3_external", constraints: {} });
      } finally {
        await database.close();
      }

      const parkTask = await createTask(options, {
        roleId,
        title: "TASK-136 park fixture",
        goal: "Send fixture mail.",
        requestedBy: "task-136-suite",
      });

      // Read directly from Postgres from *inside* the running chat turn, right
      // after the denied tool call returns — proving `withPark`'s park()
      // callback (this driver's real `RunParkPort`, via `parkTaskRun`) has
      // already committed the `waiting_approval` transition by the time the
      // hook resolves, not merely that the run ends up there eventually.
      let statusDuringRun: string | undefined;
      const queryFn: AgentSdkQueryFn = async function* (input) {
        const sdkOptions = input.options as { allowedTools?: readonly string[]; mcpServers?: Record<string, unknown> };
        if (sdkOptions.mcpServers?.gmail === undefined) throw new Error("TASK-136 fixture expected Gmail to be mounted");
        expect(sdkOptions.allowedTools).toContain("mcp__gmail__send_message(*)");

        const allowed = await callMountedTool(input, "mcp__gmail__send_message", "task-136-park", { to: "user@example.test" });
        // A pending approval is a deny at the L1/L2 SDK surface (same as any
        // other CAN-04 deny) — the model simply cannot use the tool this turn.
        expect(allowed).toBe(false);

        const row = await pool.query<{ status: string }>(
          "SELECT status FROM runs WHERE task_id = $1",
          [parkTask.taskId],
        );
        statusDuringRun = row.rows[0]?.status;
        yield { type: "tool_result", result: "mail send is pending human approval" };
      };

      await createChatRunDriver({
        ...options,
        manifests: [task128Manifest],
        queryFn,
        gmailSessionMinter: {
          resolveUrl: async () => "http://gmail.fixture.invalid/mcp",
          oauth: {
            resolve: async () => "fixture-secret",
            tokenEndpoint: "http://oauth.fixture.invalid/token",
            fetch: async () => new Response(JSON.stringify({ access_token: "task-136-fixture-token", expires_in: 3600 })),
          },
        },
      }).run({ task: parkTask, threadId });

      expect(statusDuringRun).toBe("waiting_approval");

      const run = (await listRuns(options, { taskId: parkTask.taskId })).runs[0]!;
      const events = await getAuditEventsForRun(options, run.runId);
      expect(events.find((event) => event.eventType === "policy.decision" && event.capability === "email.send"))
        .toMatchObject({ tier: "T3_external", payload: { toolName: "mcp__gmail__send_message", verdict: "require_approval" } });
      const approvals = await pool.query<{ count: string }>(
        "SELECT count(*) FROM approvals WHERE run_id = $1 AND status = 'pending'",
        [run.runId],
      );
      expect(approvals.rows[0]!.count).toBe("1");

      // The Agent SDK query loop continues past a single denied tool call
      // within the same turn, so this driver's run still finishes normally —
      // `completeRun`/`failRun` both already accept `waiting_approval` as a
      // legal source status (packages/db/src/runs.ts), so no further change
      // was needed for the run to terminate correctly after being parked.
      // This is the explicit scope narrowing this task's own Description
      // allows: reaching and proving `waiting_approval` is in scope; a live
      // continue-after-approval resume of this exact in-flight SDK session is
      // not (see dossiers/TASK-136.md).
      expect(run.status).toBe("completed");

      // AC2 — TASK-133's reconcileInterruptedRuns finds and correctly
      // handles a chat run parked this way. Fabricate an orphaned run using
      // the exact same typed `parkTaskRun` accessor this driver calls (no
      // raw SQL), simulating a worker process that died after parking but
      // before ever reaching completeTaskRun/failTaskRun.
      const orphanTask = await createTask(options, {
        roleId,
        title: "TASK-136 reconcile fixture",
        goal: "Never reached — this run is parked and abandoned mid-flight.",
        requestedBy: "task-136-suite",
      });
      const orphanRun = await startTaskRun(options, { taskId: orphanTask.taskId, provider: "claude", tenantId: "basileia" });
      await parkTaskRun(options, orphanRun.runId);
      const parkedRow = await pool.query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [orphanRun.runId]);
      expect(parkedRow.rows[0]?.status).toBe("waiting_approval");

      const outcomes = await reconcileInterruptedRuns(options, { taskId: orphanTask.taskId });
      expect(outcomes).toEqual([{ runId: orphanRun.runId, outcome: "resumed" }]);
      const resumedRow = await pool.query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [orphanRun.runId]);
      expect(resumedRow.rows[0]?.status).toBe("resumed");
    },
    120_000,
  );

  it("mounts only a role's granted Gmail tool and calls it through a real fixture HTTP MCP server (TASK-128)", async () => {
    const calls: Array<{ tool: string; authorization: string | undefined }> = [];
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequest(request)) as { id?: unknown; method?: unknown; params?: { name?: unknown } };
      if (body.method === "tools/call" && typeof body.params?.name === "string") {
        calls.push({ tool: body.params.name, authorization: request.headers.authorization });
      }
      json(response, { jsonrpc: "2.0", id: body.id ?? null, result: { content: [{ type: "text", text: "fixture response" }] } });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("TASK-128 fixture server did not bind TCP");
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
    const fixtureToken = ["task", "128", "access"].join("-");

    const database = new Database(options);
    try {
      await database.upsertRoleGrant({ roleId, capabilityId: "email.list", maxTier: "T0_observe", constraints: {} });
    } finally {
      await database.close();
    }

    const connectorCalls: string[] = [];
    const queryFn: AgentSdkQueryFn = async function* (input) {
      const sdkOptions = input.options as {
        allowedTools?: readonly string[];
        mcpServers?: Record<string, { url: string; headers?: Record<string, string> }>;
      };
      const gmail = sdkOptions.mcpServers?.gmail;
      if (gmail === undefined) throw new Error("TASK-128 fixture expected Gmail to be mounted");
      for (const [toolName, mcpTool] of [
        ["mcp__gmail__list_messages", "list_messages"],
        ["mcp__gmail__send_message", "send_message"],
      ] as const) {
        // This models the SDK's L2 surface: an unmounted tool cannot be selected
        // by the agent at all. Removing TASK-128's per-run filter adds send here,
        // which calls the fixture endpoint and reddens the assertions below.
        if (!sdkOptions.allowedTools?.includes(`${toolName}(*)`)) continue;
        const allowed = await callMountedTool(input, toolName, `task-128-${mcpTool}`, { q: "in:inbox" });
        if (!allowed) continue;
        const response = await fetch(gmail.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...gmail.headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: mcpTool, method: "tools/call", params: { name: mcpTool, arguments: {} } }),
        });
        expect(response.ok).toBe(true);
        connectorCalls.push(toolName);
        yield { type: "tool_result", toolName, result: "fixture response" };
      }
    };

    try {
      const gmailTask = await createTask(options, {
        roleId,
        title: "TASK-128 Gmail connector fixture",
        goal: "List fixture mail only.",
        requestedBy: "task-128-suite",
      });
      await createChatRunDriver({
        ...options,
        manifests: [task128Manifest],
        queryFn,
        gmailSessionMinter: {
          resolveUrl: async () => mcpUrl,
          oauth: {
            resolve: async () => "fixture-secret",
            tokenEndpoint: "http://oauth.fixture.invalid/token",
            fetch: async () => new Response(JSON.stringify({ access_token: fixtureToken, expires_in: 3600 })),
          },
        },
      }).run({ task: gmailTask, threadId });

      const run = (await listRuns(options, { taskId: gmailTask.taskId })).runs[0];
      expect(run?.status).toBe("completed");
      const events = await getAuditEventsForRun(options, run!.runId);
      expect(events.find((event) => event.eventType === "policy.decision" && event.capability === "email.list"))
        .toMatchObject({ payload: { verdict: "allow", toolName: "mcp__gmail__list_messages" } });
      expect(connectorCalls).toEqual(["mcp__gmail__list_messages"]);
      expect(calls.map((call) => call.tool)).toEqual(["list_messages"]);
      expect(calls[0]?.authorization).toBe(`Bearer ${fixtureToken}`);
      expect(sdkOptionsAbsent(calls, "send_message")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  }, 30_000);

  it("mounts Calendar and Drive only from their own grants through real fixture MCP calls (TASK-139)", async () => {
    const calls: string[] = [];
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequest(request)) as { id?: unknown; method?: unknown; params?: { name?: unknown } };
      if (body.method === "tools/call" && typeof body.params?.name === "string") calls.push(body.params.name);
      json(response, { jsonrpc: "2.0", id: body.id ?? null, result: { content: [{ type: "text", text: "fixture response" }] } });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("TASK-139 fixture server did not bind TCP");
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
    const fixtureToken = ["task", "139", "access"].join("-");
    const minterOptions = {
      resolveUrl: async () => mcpUrl,
      oauth: {
        resolve: async () => "fixture-secret",
        tokenEndpoint: "http://oauth.fixture.invalid/token",
        fetch: async () => new Response(JSON.stringify({ access_token: fixtureToken, expires_in: 3600 })),
      },
    };
    const database = new Database(options);
    try {
      // The surrounding legacy integration suite grants this shared fixture
      // role several unrelated capabilities. Reset only its grants before
      // this test so the Calendar-only mount assertion is discriminating.
      await pool.query("DELETE FROM role_grants WHERE role_id = $1", [roleId]);
      await database.upsertCapability({ capabilityId: "calendar.list", description: "List calendar events.", defaultTier: "T0_observe", adapter: "mcp:google-calendar", enabled: true });
      await database.upsertCapability({ capabilityId: "drive.search", description: "Search Drive files.", defaultTier: "T0_observe", adapter: "mcp:google-drive", enabled: true });
      await database.upsertRoleGrant({ roleId, capabilityId: "calendar.list", maxTier: "T0_observe", constraints: {} });
    } finally {
      await database.close();
    }

    const runWith = async (toolName: "mcp__google-calendar__list_events" | "mcp__google-drive__search_files") => {
      const queryFn: AgentSdkQueryFn = async function* (input) {
        const sdkOptions = input.options as {
          allowedTools?: readonly string[];
          mcpServers?: Record<string, { url: string; headers?: Record<string, string> }>;
        };
        const serverName = toolName.includes("calendar") ? "google-calendar" : "google-drive";
        const otherServerName = serverName === "google-calendar" ? "google-drive" : "google-calendar";
        const connector = sdkOptions.mcpServers?.[serverName];
        if (connector === undefined) throw new Error(`TASK-139 expected ${serverName} to be mounted`);
        expect(sdkOptions.mcpServers?.[otherServerName]).toBeUndefined();
        expect(sdkOptions.allowedTools).toContain(`${toolName}(*)`);
        const allowed = await callMountedTool(
          input,
          toolName,
          `task-139-${serverName}`,
          toolName.includes("calendar") ? { calendarId: "primary" } : { query: "quarterly report" },
        );
        expect(allowed).toBe(true);
        const response = await fetch(connector.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...connector.headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: serverName, method: "tools/call", params: { name: toolName.split("__").at(-1), arguments: {} } }),
        });
        expect(response.ok).toBe(true);
        yield { type: "tool_result", toolName, result: "fixture response" };
      };
      const task = await createTask(options, { roleId, title: `TASK-139 ${toolName} fixture`, goal: "Call the granted fixture tool once.", requestedBy: "task-139-suite" });
      await createChatRunDriver({
        ...options,
        manifests: await loadManifests(defaultManifestsDir()),
        queryFn,
        calendarSessionMinter: minterOptions,
        driveSessionMinter: minterOptions,
      }).run({ task, threadId });
      const run = (await listRuns(options, { taskId: task.taskId })).runs[0]!;
      const capability = toolName.includes("calendar") ? "calendar.list" : "drive.search";
      expect((await getAuditEventsForRun(options, run.runId)).find((event) => event.eventType === "policy.decision" && event.capability === capability))
        .toMatchObject({ payload: { verdict: "allow", toolName } });
    };

    try {
      // Calendar has a grant; Drive does not. The absent-mount assertion in
      // runWith is mutation-proof: removing the per-connector grant filter
      // mounts Drive and makes this test fail before the tool call.
      await runWith("mcp__google-calendar__list_events");
      const grantDatabase = new Database(options);
      try {
        await pool.query("DELETE FROM role_grants WHERE role_id = $1 AND capability_id = 'calendar.list'", [roleId]);
        await grantDatabase.upsertRoleGrant({ roleId, capabilityId: "drive.search", maxTier: "T0_observe", constraints: {} });
      } finally {
        await grantDatabase.close();
      }
      // Reverse direction is independently asserted: Drive has a grant while
      // Calendar does not. A filter removal mounts Calendar and reddens the
      // unconditional absent-mount assertion in runWith.
      await runWith("mcp__google-drive__search_files");
      expect(calls).toEqual(["list_events", "search_files"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  }, 30_000);

});

function sdkOptionsAbsent(calls: readonly { tool: string }[], tool: string): boolean {
  return !calls.some((call) => call.tool === tool);
}

integration("createChatRunDriver — send_to_role governed MCP run (TASK-131)", () => {
  const senderRoleId = "task-131-chat-sender";
  const receiverRoleId = "task-131-chat-receiver";
  let pool: Pool;
  let options: DatabaseOptions;
  let threadId: string;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM role_messages WHERE from_role_id = ANY($1::text[]) OR to_role_id = ANY($1::text[])", [[senderRoleId, receiverRoleId]]);
    await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [senderRoleId]);
    await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [senderRoleId]);
    await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [senderRoleId]);
    await pool.query("DELETE FROM tasks WHERE role_id = $1", [senderRoleId]);
    await pool.query("DELETE FROM thread_members WHERE role_id = ANY($1::text[])", [[senderRoleId, receiverRoleId]]);
    await pool.query("DELETE FROM threads WHERE role_id = ANY($1::text[])", [[senderRoleId, receiverRoleId]]);
    await pool.query("DELETE FROM role_grants WHERE role_id = ANY($1::text[])", [[senderRoleId, receiverRoleId]]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [[senderRoleId, receiverRoleId]]);
  }

  beforeAll(async () => {
    process.env.OIKONOMOS_CAPABILITIES_ENABLED = "true";
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    for (const roleId of [senderRoleId, receiverRoleId]) await createRole(options, { roleId, name: roleId, title: "TASK-131 chat fixture", description: "TASK-131 real governed MCP run fixture." });
    const database = new Database(options);
    try {
      await database.upsertCapability({ capabilityId: "workspace.send_to_role", description: "Send an asynchronous role handoff.", defaultTier: "T1_draft", adapter: "mcp:workspace", enabled: true });
      await database.upsertRoleGrant({ roleId: senderRoleId, capabilityId: "workspace.send_to_role", maxTier: "T1_draft", constraints: {} });
    } finally { await database.close(); }
    threadId = (await pool.query<{ id: string }>("INSERT INTO threads (role_id) VALUES ($1) RETURNING id", [senderRoleId])).rows[0]!.id;
  });

  afterAll(async () => { await cleanup(); await pool.end(); });

  it("allows a granted typed handoff through the mounted MCP bridge and persists role_messages", async () => {
    const queryFn: AgentSdkQueryFn = async function* (input) {
      const sdkOptions = input.options as { allowedTools?: readonly string[]; mcpServers?: Record<string, { type: string; command?: string; args?: readonly string[] }> };
      const workspace = sdkOptions.mcpServers?.workspace;
      expect(workspace).toMatchObject({ type: "stdio" });
      expect(workspace?.command).toBe(process.execPath);
      expect(workspace?.args?.[0]).toMatch(/workspaceMcpServer\.js$/);
      expect(sdkOptions.allowedTools).toContain("mcp__workspace__send_to_role(*)");
      expect(await callMountedTool(input, "mcp__workspace__send_to_role", "task-131-granted", { toRoleId: receiverRoleId, body: "Review this typed finding.", handoffKind: "research.complete", factRef: { tenantId: "basileia", scope: "agent", roleId: senderRoleId, key: "finding" } })).toBe(true);
      const response = await handleWorkspaceMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_to_role", arguments: { toRoleId: receiverRoleId, body: "Review this typed finding.", handoffKind: "research.complete", factRef: { tenantId: "basileia", scope: "agent", roleId: senderRoleId, key: "finding" } } } }), { connectionString: connectionString!, tenantId: "basileia", fromRoleId: senderRoleId });
      expect(response).toHaveProperty("result.content");
      yield { type: "tool_result", result: "handoff sent" };
    };
    const task = await createTask(options, { roleId: senderRoleId, title: "TASK-131 granted handoff", goal: "Send the typed handoff.", requestedBy: "task-131-suite" });
    await createChatRunDriver({ ...options, queryFn }).run({ task, threadId });
    const run = (await listRuns(options, { taskId: task.taskId })).runs[0]!;
    const events = await getAuditEventsForRun(options, run.runId);
    expect(events.find((event) => event.eventType === "policy.decision" && event.capability === "workspace.send_to_role")).toMatchObject({ payload: { verdict: "allow", toolName: "mcp__workspace__send_to_role" } });
    expect((await pool.query("SELECT handoff_kind, fact_ref FROM role_messages WHERE from_role_id = $1", [senderRoleId])).rows).toHaveLength(1);
  });

  it("denies the ungranted tool at policy.decision before any mailbox write", async () => {
    await pool.query("DELETE FROM role_grants WHERE role_id = $1 AND capability_id = 'workspace.send_to_role'", [senderRoleId]);
    const queryFn: AgentSdkQueryFn = async function* (input) {
      const sdkOptions = input.options as { allowedTools?: readonly string[]; mcpServers?: Record<string, unknown> };
      expect(sdkOptions.mcpServers?.workspace).toBeUndefined();
      expect(sdkOptions.allowedTools).not.toContain("mcp__workspace__send_to_role(*)");
      expect(await callMountedTool(input, "mcp__workspace__send_to_role", "task-131-denied", { toRoleId: receiverRoleId, body: "must not send" })).toBe(false);
      yield { type: "tool_result", result: "denied" };
    };
    const task = await createTask(options, { roleId: senderRoleId, title: "TASK-131 denied handoff", goal: "Attempt an ungranted handoff.", requestedBy: "task-131-suite" });
    await createChatRunDriver({ ...options, queryFn }).run({ task, threadId });
    const run = (await listRuns(options, { taskId: task.taskId })).runs[0]!;
    const events = await getAuditEventsForRun(options, run.runId);
    expect(events.find((event) => event.eventType === "policy.decision" && event.capability === "workspace.send_to_role")).toMatchObject({ payload: { verdict: "deny", reason: "role.grant_missing", toolName: "mcp__workspace__send_to_role" } });
    expect((await pool.query("SELECT count(*) FROM role_messages WHERE from_role_id = $1", [senderRoleId])).rows[0]!.count).toBe("1");
  });
});

// TASK-122 (Chat-2c): the fan-out-approval rule, confirmed against the real
// Grok Bot reference product 2026-09-03 — a single 1:1 bot-to-bot message
// needs no human approval; fan-out to 2+ bots/a group does. Real Postgres,
// same evidentiary bar as TASK-116/117's own liveness assertions above:
// AC3's mutation-proof shape is satisfied because `deliverBotToBotMessage`'s
// only branch point is `toRoleIds.length > 1` — deleting that guard (so
// every call falls through to direct delivery) makes the fan-out case
// insert messages with zero pending approvals, reddening this suite's own
// "produces a pending approval" assertion below.
integration("deliverBotToBotMessage — fan-out approval rule (TASK-122)", () => {
  let pool: Pool;
  let options: DatabaseOptions;
  const fromRoleId = "task-122-fanout-sender";
  const toRoleIdA = "task-122-fanout-recipient-a";
  const toRoleIdB = "task-122-fanout-recipient-b";
  const allRoleIds = [fromRoleId, toRoleIdA, toRoleIdB];
  let runId: string;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))`,
      [fromRoleId],
    );
    await pool.query(
      `DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = ANY($1::text[]))`,
      [allRoleIds],
    );
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`,
      [fromRoleId],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [fromRoleId]);
    await pool.query(`DELETE FROM thread_members WHERE role_id = ANY($1::text[])`, [allRoleIds]);
    await pool.query(`DELETE FROM threads WHERE role_id = ANY($1::text[])`, [allRoleIds]);
    await pool.query(`DELETE FROM role_grants WHERE role_id = ANY($1::text[])`, [allRoleIds]);
    await pool.query(`DELETE FROM roles WHERE role_id = ANY($1::text[])`, [allRoleIds]);
    await pool.query(`DELETE FROM capabilities WHERE capability_id = $1`, [CHAT_FANOUT_CAPABILITY_ID]);
  }

  beforeAll(async () => {
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();

    for (const roleId of allRoleIds) {
      await createRole(options, {
        roleId,
        name: roleId,
        title: "TASK-122 fan-out fixture role",
        description: "TASK-122 deliverBotToBotMessage integration fixture.",
      });
    }
    const task = await createTask(options, {
      roleId: fromRoleId,
      title: "TASK-122 fan-out fixture task",
      goal: "fixture task backing a real run for approvals.run_id's FK",
      requestedBy: "task-122-suite",
    });
    const run = await startTaskRun(options, { taskId: task.taskId, provider: "claude", tenantId: task.tenantId });
    runId = run.runId;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("a single bot messaging exactly one other bot delivers immediately, no pending approval", async () => {
    const result = await deliverBotToBotMessage(options, {
      fromRoleId,
      toRoleIds: [toRoleIdA],
      body: "single-recipient delegation ping",
      runId,
    });
    expect(result.delivered).toBe(true);

    const thread = await getOrCreateThreadForRole(options, { roleId: toRoleIdA });
    const messages = await listMessages(options, thread.id);
    const delivered = messages.find((message) => message.body === "single-recipient delegation ping");
    expect(delivered).toBeDefined();
    expect(delivered?.senderRoleId).toBe(fromRoleId);

    const approvals = await pool.query<{ count: string }>(
      "SELECT count(*) FROM approvals WHERE run_id = $1 AND status = 'pending'",
      [runId],
    );
    expect(approvals.rows[0]!.count).toBe("0");
  });

  it("a bot messaging multiple bots/a group in one action produces a real pending approval instead of delivering", async () => {
    const result = await deliverBotToBotMessage(options, {
      fromRoleId,
      toRoleIds: [toRoleIdA, toRoleIdB],
      body: "fan-out ping that must not be sent yet",
      runId,
    });
    expect(result.delivered).toBe(false);
    if (result.delivered) throw new Error("unreachable");
    expect(result.approval.status).toBe("pending");

    const approvalRow = await pool.query<{ status: string; capability_id: string }>(
      "SELECT status, capability_id FROM approvals WHERE nonce = $1",
      [result.approval.nonce],
    );
    expect(approvalRow.rows[0]).toMatchObject({ status: "pending", capability_id: CHAT_FANOUT_CAPABILITY_ID });

    // Nothing was sent to either recipient — the gate ran before delivery.
    const threadA = await getOrCreateThreadForRole(options, { roleId: toRoleIdA });
    const threadB = await getOrCreateThreadForRole(options, { roleId: toRoleIdB });
    const [messagesA, messagesB] = await Promise.all([
      listMessages(options, threadA.id),
      listMessages(options, threadB.id),
    ]);
    expect(messagesA.some((message) => message.body === "fan-out ping that must not be sent yet")).toBe(false);
    expect(messagesB.some((message) => message.body === "fan-out ping that must not be sent yet")).toBe(false);
  });

  it("rejects an empty recipient list before touching the database", async () => {
    await expect(
      deliverBotToBotMessage(options, { fromRoleId, toRoleIds: [], body: "no recipients", runId }),
    ).rejects.toThrow(/at least one recipient/);
  });
});
