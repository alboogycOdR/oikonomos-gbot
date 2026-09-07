import {
  Database,
  createRole,
  createTask,
  defaultPoolConfig,
  getAuditEventsForRun,
  getOrCreateThreadForRole,
  getRoleSandbox,
  insertMessage,
  listMessages,
  listRuns,
  upsertRoleSandbox,
  type DatabaseOptions,
} from "@oikonomos/db";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSdkQueryFn, AgentSdkQueryInput } from "@oikonomos/harness-factory";
import { defaultManifestsDir, loadManifests, type ConnectorManifest } from "@oikonomos/connectors";
import type { Sandbox, SandboxClient, SandboxEndpoint } from "@oikonomos/sandbox-client";

import {
  createChatRunDriver,
  chatExecutionMode,
  claudePrintCommand,
  destinationFor,
  finalText,
  LOCAL_LANE_MODEL,
  resolveChatRunExecution,
  sandboxEntrypointFor,
  SPEND_UNRECORDED_EVENT_TYPE,
} from "./chatRunDriver.js";
import { parkTaskRun, reconcileInterruptedRuns, startTaskRun } from "./runLifecycle.js";
import { handleWorkspaceMcpRequest } from "./workspaceMcpServer.js";

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
  it("defaults to the sandbox path and constructs a scoped governed CLI command", () => {
    expect(chatExecutionMode({})).toBe("sandbox");
    expect(chatExecutionMode({ OIKONOMOS_CHAT_EXECUTION_MODE: "local" })).toBe("local");
    expect(chatExecutionMode({ OIKONOMOS_CHAT_EXECUTION_MODE: "typo" })).toBe("sandbox");
    const command = claudePrintCommand("answer 'safely'", "system prompt", "session-1");
    expect(command).toContain("claude -p --permission-mode dontAsk --output-format text");
    expect(command).toContain("--model 'claude-haiku-4-5-20251001'");
    expect(command).toContain("--allowedTools 'Bash Read'");
    expect(command).toContain("--system-prompt 'system prompt'");
    expect(command).toContain("--resume 'session-1'");
    expect(command).toContain("safely");
  });

  it("extends the CLI's allowed-tools set and mounts an --mcp-config only when a connector is supplied (TASK-204 AC2)", () => {
    const withoutConnector = claudePrintCommand("hi", "sp");
    expect(withoutConnector).toContain("--allowedTools 'Bash Read'");
    expect(withoutConnector).not.toContain("--mcp-config");

    const withConnector = claudePrintCommand("hi", "sp", undefined, "text", {
      allowedTools: ["mcp__steel__steel_navigate", "mcp__steel__steel_snapshot"],
      mcpServers: { steel: { transport: "stdio", command: "node", args: ["/opt/oikonomos/steel-mcp/dist/stdio.js"] } },
    });
    expect(withConnector).toContain("--allowedTools 'Bash Read mcp__steel__steel_navigate mcp__steel__steel_snapshot'");
    expect(withConnector).toContain("--mcp-config");
    // The config JSON contains no single quotes, so shellQuote wraps it
    // verbatim (its escaping only fires on an embedded `'`).
    expect(withConnector).toContain(`'${JSON.stringify({ mcpServers: { steel: { transport: "stdio", command: "node", args: ["/opt/oikonomos/steel-mcp/dist/stdio.js"] } } })}'`);

    // A connector with no mounted servers (shouldn't happen in practice —
    // resolveGrantedBrowserConnector only returns one with granted tools —
    // but must not emit an empty/broken --mcp-config flag regardless).
    expect(claudePrintCommand("hi", "sp", undefined, "text", { allowedTools: [], mcpServers: {} })).not.toContain("--mcp-config");
  });

  it("honors an OIKONOMOS_SANDBOX_MODEL override instead of the cheap default", () => {
    const previous = process.env.OIKONOMOS_SANDBOX_MODEL;
    process.env.OIKONOMOS_SANDBOX_MODEL = "claude-opus-5";
    try {
      expect(claudePrintCommand("hi", "sp")).toContain("--model 'claude-opus-5'");
    } finally {
      if (previous === undefined) delete process.env.OIKONOMOS_SANDBOX_MODEL;
      else process.env.OIKONOMOS_SANDBOX_MODEL = previous;
    }
  });

  it("uses the scoped built-in mount while leaving Agent SDK query ownership to harness-factory", () => {
    expect(chatRunDriverSource).toContain('allowedTools: ["Bash(*)", "Read(*)"]');
    // TASK-128 has an injected query seam for its protocol-compatible MCP
    // fixture; production still leaves Agent SDK ownership with the factory.
    expect(chatRunDriverSource).toContain("options.queryFn");
    expect(chatRunDriverSource).not.toContain("@anthropic-ai/claude-agent-sdk");
  });

  // TASK-208: the entrypoint must follow the image actually selected.
  // Pinning it to the base wrapper meant office-browser's own Steel-starting
  // script never ran in a real sandbox — OpenSandbox replaces the image's
  // Docker ENTRYPOINT with its own bootstrap and runs THIS field instead.
  it("pairs each sandbox image with the entrypoint that image can actually run (TASK-208)", () => {
    expect(sandboxEntrypointFor("oikonomos-office-browser:claude-2.1.263")).toEqual([
      "/opt/oikonomos/browser-entrypoint.sh", "tail", "-f", "/dev/null",
    ]);
    expect(sandboxEntrypointFor("oikonomos-office-base:claude-2.1.263")).toEqual([
      "node", "/opt/oikonomos/egress-entrypoint.mjs", "tail", "-f", "/dev/null",
    ]);
    // An unrecognized override falls back to the base wrapper: every office-*
    // image carries egress-entrypoint.mjs, only office-browser carries
    // browser-entrypoint.sh, so this is the fail-safe direction.
    expect(sandboxEntrypointFor("some-operator-override:latest")).toEqual([
      "node", "/opt/oikonomos/egress-entrypoint.mjs", "tail", "-f", "/dev/null",
    ]);
  });

  // TASK-210 — spend attribution must describe what actually ran. The old
  // code recorded `provider: "claude"` plus the SANDBOX model string on both
  // lanes, so a local-lane run was labelled with a model it never used, and
  // any non-Anthropic run would have been attributed to Claude outright —
  // invisible to TASK-209's per-provider cap, which keys on that column.
  it("attributes a run to the lane that actually executes it, not to a literal (TASK-210)", () => {
    const db = { connectionString: "postgres://example/db" };
    const previousModel = process.env.OIKONOMOS_SANDBOX_MODEL;
    try {
      delete process.env.OIKONOMOS_SANDBOX_MODEL;
      // The sandbox lane — the PRODUCTION one — does pin a model.
      expect(resolveChatRunExecution(db, true)).toEqual({
        provider: "claude",
        model: "claude-haiku-4-5-20251001",
      });

      process.env.OIKONOMOS_SANDBOX_MODEL = "claude-opus-5";
      expect(resolveChatRunExecution(db, true).model).toBe("claude-opus-5");

      // The local lane pins no model at all — the SDK chooses. Naming that is
      // truthful; borrowing the sandbox model string, as the old code did,
      // labelled every local run with a model it never used.
      expect(resolveChatRunExecution(db, false)).toEqual({
        provider: "claude",
        model: LOCAL_LANE_MODEL,
      });
    } finally {
      if (previousModel === undefined) delete process.env.OIKONOMOS_SANDBOX_MODEL;
      else process.env.OIKONOMOS_SANDBOX_MODEL = previousModel;
    }
  });

  it("names the provider vocabulary TASK-209's cap reads back (TASK-210)", () => {
    // A cap keyed on a name nothing writes is silently inert. These must stay
    // the same string in both places; this test is the pin.
    expect(resolveChatRunExecution({ connectionString: "postgres://example/db" }, true).provider).toBe("claude");
    expect(SPEND_UNRECORDED_EVENT_TYPE).toBe("spend.unrecorded");
  });

  it("derives only ADR-013's approved destinations and fails closed otherwise", () => {
    expect(destinationFor({ ...base, toolName: "Read", input: { file_path: "src/app.ts" } })).toBe("src/app.ts");
    expect(destinationFor({ ...base, toolName: "Glob", input: { pattern: "src/**/*.ts" } })).toBe("src/**/*.ts");
    expect(destinationFor({ ...base, toolName: "Bash", input: { command: "git status" } })).toBe("git status");
    expect(destinationFor({ ...base, toolName: "mcp__gmail__send_message", input: { to: "user@example.test" } })).toBe("user@example.test");
    expect(destinationFor({ ...base, toolName: "mcp__steel__steel_session_create", input: {} })).toBe("current_page");
    expect(destinationFor({ ...base, toolName: "mcp__steel__steel_session_release", input: {} })).toBe("current_page");
    expect(() => destinationFor({ ...base, toolName: "WebFetch", input: { url: "https://example.test" } })).toThrow(/No governed destination/);
  });

  // TASK-207 non-blocking (Fable review of d44e64a): the exact bug class
  // this task fixed — a manifest tool declared with no matching
  // destinationFor branch — is only caught by hand when someone happens to
  // exercise that specific tool. This closure test catches it for every
  // tool the steel-browser manifest declares, automatically, the moment a
  // new one is added without updating destinationFor to match.
  //
  // TASK-216 widened this from steel-browser-only to EVERY loaded manifest.
  // When it was scoped, running it unscoped surfaced ~13 tools with no
  // branch — gmail create_draft, calendar get_event, and nine live Drive
  // tools — each of which threw and was therefore denied.
  it("gives every tool declared by every connector manifest a non-throwing destination (closure over destinationFor)", async () => {
    const manifests = await loadManifests(defaultManifestsDir());
    // Only tools that can actually be MOUNTED. `enabled: false` tools are
    // unreachable, and the three that remain — calendar create/update/delete
    // event — are T3 externally-visible actions whose input schemas this
    // project has not enumerated against its own MCP server
    // (docs/connectors/google-calendar.md records tiers only). Writing
    // convention-guessed extractors for calls that notify real attendees is
    // exactly where a wrong field name costs most. Keying on `enabled` means
    // this test starts demanding a branch the moment one is switched on,
    // which is precisely when it matters.
    const toolNames = manifests.flatMap((manifest) =>
      manifest.tools.filter((tool) => tool.enabled !== false).map((tool) => tool.tool_name));
    expect(toolNames.length).toBeGreaterThan(14);

    // One input carrying every field any governed tool reads, so a tool is
    // reported missing only when it has no extractor at all.
    const input = {
      url: "https://example.test", action: "click", q: "is:unread",
      to: ["user@example.test"], subject: "Subject", calendarId: "primary", eventId: "evt-1",
      query: "report", fileId: "file-1", title: "Notes", path: "src", command: "ls",
      file_path: "a.md", toRoleId: "role", name: "n", label: "l",
    };

    const missing: string[] = [];
    for (const toolName of toolNames) {
      try {
        destinationFor({ ...base, toolName, input });
      } catch {
        missing.push(toolName);
      }
    }
    expect(missing, "destinationFor has no branch for these manifest tools").toEqual([]);
  });

  it("extracts a real target per tool, not a placeholder (TASK-216)", () => {
    const at = (toolName: string, input: Record<string, unknown>) => destinationFor({ ...base, toolName, input });

    // Gmail's create_draft takes an ARRAY of recipients while send_message
    // takes a string; a copied branch would have produced "[object Object]"
    // or an empty destination and denied the call.
    expect(at("mcp__gmail__create_draft", { to: ["a@example.test", "b@example.test"] })).toBe("a@example.test, b@example.test");
    expect(at("mcp__gmail__send_message", { to: "a@example.test" })).toBe("a@example.test");
    // A draft with no recipient yet is still describable by its subject.
    expect(at("mcp__gmail__create_draft", { subject: "Q3 numbers" })).toBe("Q3 numbers");

    expect(at("mcp__google-drive__read_file_content", { fileId: "file-1" })).toBe("file-1");
    expect(at("mcp__google-drive__create_file", { title: "Notes" })).toBe("Notes");
    expect(at("mcp__google-calendar__get_event", { eventId: "evt-1" })).toBe("evt-1");
  });

  it("still fails closed for a tool no manifest declares (TASK-216)", () => {
    expect(() => destinationFor({ ...base, toolName: "mcp__unknown__exfiltrate", input: { fileId: "f" } }))
      .toThrow(/No governed destination/);
    // Present in the table but with nothing to name still denies.
    expect(() => destinationFor({ ...base, toolName: "mcp__google-drive__read_file_content", input: {} }))
      .toThrow(/No governed destination/);
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
    await pool.query(`DELETE FROM role_sandboxes WHERE role_id = $1`, [roleId]);
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
    // This additive migration is deliberately run by the migration-backed
    // integration suite so a checked-out branch can prove its new accessor
    // before an external deployment migration runner has caught up.
    const roleSandboxTable = await pool.query<{ table_name: string | null }>("SELECT to_regclass('public.role_sandboxes') AS table_name");
    if (roleSandboxTable.rows[0]?.table_name === null) {
      await pool.query(await readFile(new URL("../../../infra/postgres/migrations/018_role_sandboxes.up.sql", import.meta.url), "utf8"));
    }
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

  it("creates a role office once, then resumes it and re-resolves execd for the next sandboxed turn (TASK-170)", async () => {
    const ANTHROPIC_API_KEY_VAR = ["OIK_SECRET_ANTHROPIC", "API_KEY"].join("_");
    const previousBrokerUrl = process.env.OIK_SANDBOX_BROKER_URL;
    const previousSigningKey = process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY;
    const previousAnthropicApiKey = process.env[ANTHROPIC_API_KEY_VAR];
    process.env.OIK_SANDBOX_BROKER_URL = "http://broker.test:3001";
    process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = "task-170-test-signing-key";
    process.env[ANTHROPIC_API_KEY_VAR] = "task-170-test-anthropic-credential";
    let state: Sandbox["status"]["state"] = "Running";
    let egressPolicyApplied = true;
    let creates = 0;
    const createRequests: Array<Parameters<SandboxClient["createSandbox"]>[0]> = [];
    let resumes = 0;
    let pauses = 0;
    const endpointCalls: string[] = [];
    const commands: Array<Parameters<SandboxClient["runCommand"]>[1]> = [];
    const fakeSandbox: SandboxClient = {
      health: async () => ({ status: "ok" }),
      createSandbox: async (request) => {
        creates += 1;
        createRequests.push(request);
        return { id: "task-170-office", createdAt: "2026-09-06T00:00:00Z", status: { state } };
      },
      getSandbox: async () => ({ id: "task-170-office", createdAt: "2026-09-06T00:00:00Z", status: { state } }),
      destroySandbox: async () => undefined,
      pauseSandbox: async () => { pauses += 1; state = "Paused"; },
      resumeSandbox: async () => { resumes += 1; state = "Running"; },
      getEndpoint: async (): Promise<SandboxEndpoint> => {
        const endpoint = `http://execd.test/${endpointCalls.length + 1}`;
        endpointCalls.push(endpoint);
        return { endpoint };
      },
      ping: async () => undefined,
      runCommand: async (_endpoint, command) => {
        if (command.command === "/usr/bin/sha256sum /etc/claude-code/managed-settings.json") {
          return {
            stdout: "886c6ad71724d395fd4600dd8cc0625df68686808409d6657fab8e9737083854  /etc/claude-code/managed-settings.json\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (command.command === "test -f /run/oikonomos/egress-policy-applied") {
          return { stdout: "", stderr: "", exitCode: egressPolicyApplied ? 0 : 1 };
        }
        commands.push(command);
        return { stdout: "Sandbox turn complete", stderr: "", exitCode: 0 };
      },
    };

    try {
      const driver = createChatRunDriver({ ...options, sandboxClient: fakeSandbox });
      await driver.run({ task, threadId });
      await driver.run({ task, threadId });

      expect(creates).toBe(1);
      expect(createRequests[0]?.networkPolicy).toEqual({ defaultAction: "allow", egress: [] });
      // TASK-185 regression guard: OpenSandbox's own container entrypoint is
      // ALWAYS its own bootstrap.sh (verified live against a real created
      // sandbox — `docker inspect` showed `Config.Entrypoint =
      // ["/opt/opensandbox/bootstrap.sh"]`, never the image's declared
      // ENTRYPOINT), which runs this request's `entrypoint` array as its own
      // CMD. The image's `ENTRYPOINT` directive is therefore NEVER reached by
      // a real deployment — if this array ever reverts to a bare
      // `["tail", "-f", "/dev/null"]`, the marker-writing wrapper silently
      // stops running and `assertEgressPolicyApplied` would refuse every
      // governed command in production, indistinguishable from a healthy
      // sandbox missing its sidecar.
      expect(createRequests[0]?.entrypoint).toEqual(["node", "/opt/oikonomos/egress-entrypoint.mjs", "tail", "-f", "/dev/null"]);
      expect(resumes).toBe(1);
      expect(pauses).toBe(2);
      expect(endpointCalls).toEqual(["http://execd.test/1", "http://execd.test/2"]);
      expect(commands).toHaveLength(4);
      expect(commands[0]).toMatchObject({
        command: `mkdir -p -- '/workspace/${roleId}'`,
        cwd: "/workspace",
        envs: {},
      });
      expect(commands[2]).toMatchObject({
        command: `mkdir -p -- '/workspace/${roleId}'`,
        cwd: "/workspace",
        envs: {},
      });
      expect(commands[1]?.envs).toMatchObject({
        OIK_SANDBOX_BROKER_URL: "http://broker.test:3001",
        OIK_SANDBOX_ROLE_ID: roleId,
        OIK_SANDBOX_TENANT_ID: task.tenantId,
        [["ANTHROPIC", "API_KEY"].join("_")]: "task-170-test-anthropic-credential",
      });
      expect(commands[1]?.envs).not.toHaveProperty("OIK_SECRET_BROKER_TOKEN_SIGNING_KEY");
      expect(commands[1]?.envs).not.toHaveProperty(ANTHROPIC_API_KEY_VAR);

      egressPolicyApplied = false;
      await expect(driver.run({ task, threadId })).rejects.toThrow("Sandbox egress policy marker is absent");
      // The refusal happens before workspace setup or the governed Claude command.
      expect(commands).toHaveLength(4);
    } finally {
      if (previousBrokerUrl === undefined) delete process.env.OIK_SANDBOX_BROKER_URL;
      else process.env.OIK_SANDBOX_BROKER_URL = previousBrokerUrl;
      if (previousSigningKey === undefined) delete process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY;
      else process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = previousSigningKey;
      if (previousAnthropicApiKey === undefined) delete process.env[ANTHROPIC_API_KEY_VAR];
      else process.env[ANTHROPIC_API_KEY_VAR] = previousAnthropicApiKey;
    }
  });

  // TASK-222 — the DB's cached sandbox state can drift from the sandbox's own
  // reality (manual operator intervention was the real-world trigger this
  // session, but a crashed mid-transition run or two racing worker instances
  // produce the identical shape). Both directions were live failures before
  // this fix: resuming an already-Running sandbox threw
  // DOCKER::SANDBOX_NOT_PAUSED; a DB row stuck on "Running" while the real
  // sandbox was Paused was never even checked, so the turn spun in
  // waitForSandboxRunning until its own timeout instead of resuming.
  it("reconciles a drifted sandbox state instead of trusting the stale DB record (TASK-222)", async () => {
    const ANTHROPIC_API_KEY_VAR = ["OIK_SECRET_ANTHROPIC", "API_KEY"].join("_");
    const previousBrokerUrl = process.env.OIK_SANDBOX_BROKER_URL;
    const previousSigningKey = process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY;
    const previousAnthropicApiKey = process.env[ANTHROPIC_API_KEY_VAR];
    process.env.OIK_SANDBOX_BROKER_URL = "http://broker.test:3001";
    process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = "task-222-test-signing-key";
    process.env[ANTHROPIC_API_KEY_VAR] = "task-222-test-anthropic-credential";

    const driftRoleId = "task-222-sandbox-drift";
    // Delete order mirrors the suite-level cleanup() above: messages/
    // audit_events/approvals FK-reference runs, which FK-references tasks.
    await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [driftRoleId]);
    await pool.query("DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [driftRoleId]);
    await pool.query("DELETE FROM messages WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [driftRoleId]);
    await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [driftRoleId]);
    await pool.query("DELETE FROM role_sandboxes WHERE role_id = $1", [driftRoleId]);
    await pool.query("DELETE FROM tasks WHERE role_id = $1", [driftRoleId]);
    await pool.query("DELETE FROM threads WHERE role_id = $1", [driftRoleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [driftRoleId]);
    await createRole(options, { roleId: driftRoleId, name: driftRoleId, title: "TASK-222 drift fixture", description: "" });
    const driftTask = await createTask(options, { roleId: driftRoleId, title: "TASK-222 fixture", goal: "Run `pwd`.", requestedBy: "task-222-suite" });
    const driftThreadResult = await pool.query<{ id: string }>(
      `INSERT INTO threads (role_id) VALUES ($1) RETURNING id`,
      [driftRoleId],
    );
    const driftThreadId = driftThreadResult.rows[0]!.id;

    // Live sandbox state the fake client reports — independent of whatever
    // the DB record says, which is exactly the point.
    let liveState: Sandbox["status"]["state"] = "Running";
    let resumeCalls = 0;
    const driftClient: SandboxClient = {
      health: async () => ({ status: "ok" }),
      createSandbox: async () => ({ id: "task-222-office", createdAt: "2026-09-07T00:00:00Z", status: { state: liveState } }),
      getSandbox: async () => ({ id: "task-222-office", createdAt: "2026-09-07T00:00:00Z", status: { state: liveState } }),
      destroySandbox: async () => undefined,
      pauseSandbox: async () => { liveState = "Paused"; },
      // Mirrors the real OpenSandbox behavior this task's bug report was
      // built on: resuming an already-Running sandbox is a real error
      // (DOCKER::SANDBOX_NOT_PAUSED), not a no-op. This is what makes
      // direction 1 below an actual regression guard rather than a check
      // that happens to pass either way.
      resumeSandbox: async () => {
        if (liveState === "Running") throw new Error("DOCKER::SANDBOX_NOT_PAUSED");
        resumeCalls += 1;
        liveState = "Running";
      },
      getEndpoint: async () => ({ endpoint: "http://execd.test/task-222" }),
      ping: async () => undefined,
      runCommand: async (_endpoint, command) => {
        if (command.command === "/usr/bin/sha256sum /etc/claude-code/managed-settings.json") {
          return { stdout: "886c6ad71724d395fd4600dd8cc0625df68686808409d6657fab8e9737083854  /etc/claude-code/managed-settings.json\n", stderr: "", exitCode: 0 };
        }
        if (command.command === "test -f /run/oikonomos/egress-policy-applied") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "Sandbox turn complete", stderr: "", exitCode: 0 };
      },
    };

    try {
      // DB says Paused; the sandbox is actually already Running. Before this
      // fix, this called resumeSandbox on an already-running sandbox — the
      // real DOCKER::SANDBOX_NOT_PAUSED failure hit repeatedly today.
      await upsertRoleSandbox(options, { roleId: driftRoleId, sandboxId: "task-222-office", state: "Paused", execdTokenRef: "secret://opensandbox/execd_access_token" });
      liveState = "Running";

      // A driver still trusting the stale "Paused" record would call
      // resumeSandbox here and hit the fake's DOCKER::SANDBOX_NOT_PAUSED
      // throw, since the live sandbox is already Running. Reconciling first
      // means the run completes cleanly instead.
      const driver = createChatRunDriver({ ...options, sandboxClient: driftClient });
      await driver.run({ task: driftTask, threadId: driftThreadId });
      expect(resumeCalls).toBe(0);
      // The normal end-of-turn pause runs after every completed turn (same
      // as TASK-170), so the DB is "Paused" again by the time the run
      // returns — that's expected, not a sign reconciliation didn't happen.
      liveState = "Paused";

      // Reverse direction: DB says Running; the sandbox is actually Paused.
      // Before this fix, the resume branch was never even reached — the turn
      // would spin in waitForSandboxRunning polling a sandbox that can never
      // become Running without an explicit resume, until its own timeout.
      await upsertRoleSandbox(options, { roleId: driftRoleId, sandboxId: "task-222-office", state: "Running", execdTokenRef: "secret://opensandbox/execd_access_token" });

      await driver.run({ task: driftTask, threadId: driftThreadId });

      expect(resumeCalls).toBe(1);
    } finally {
      if (previousBrokerUrl === undefined) delete process.env.OIK_SANDBOX_BROKER_URL;
      else process.env.OIK_SANDBOX_BROKER_URL = previousBrokerUrl;
      if (previousSigningKey === undefined) delete process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY;
      else process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = previousSigningKey;
      if (previousAnthropicApiKey === undefined) delete process.env[ANTHROPIC_API_KEY_VAR];
      else process.env[ANTHROPIC_API_KEY_VAR] = previousAnthropicApiKey;
      await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [driftRoleId]);
      await pool.query("DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [driftRoleId]);
      await pool.query("DELETE FROM messages WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [driftRoleId]);
      await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [driftRoleId]);
      await pool.query("DELETE FROM role_sandboxes WHERE role_id = $1", [driftRoleId]);
      await pool.query("DELETE FROM tasks WHERE role_id = $1", [driftRoleId]);
      await pool.query("DELETE FROM threads WHERE role_id = $1", [driftRoleId]);
      await pool.query("DELETE FROM roles WHERE role_id = $1", [driftRoleId]);
    }
  });

  // A genuinely dead/unreachable sandbox must still fail closed — reconciling
  // drift must never be mistaken for tolerating a real failure.
  it("still fails closed when the sandbox is genuinely unreachable, not silently treated as drift (TASK-222)", async () => {
    const unreachableClient: SandboxClient = {
      health: async () => ({ status: "ok" }),
      createSandbox: async () => ({ id: "task-222-dead", createdAt: "2026-09-07T00:00:00Z", status: { state: "Running" } }),
      getSandbox: async () => { throw new Error("sandbox not found"); },
      destroySandbox: async () => undefined,
      pauseSandbox: async () => undefined,
      resumeSandbox: async () => undefined,
      getEndpoint: async () => ({ endpoint: "http://execd.test/task-222-dead" }),
      ping: async () => undefined,
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as SandboxClient;

    const deadRoleId = "task-222-sandbox-dead";
    await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [deadRoleId]);
    await pool.query("DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [deadRoleId]);
    await pool.query("DELETE FROM messages WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [deadRoleId]);
    await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [deadRoleId]);
    await pool.query("DELETE FROM role_sandboxes WHERE role_id = $1", [deadRoleId]);
    await pool.query("DELETE FROM tasks WHERE role_id = $1", [deadRoleId]);
    await pool.query("DELETE FROM threads WHERE role_id = $1", [deadRoleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [deadRoleId]);
    await createRole(options, { roleId: deadRoleId, name: deadRoleId, title: "TASK-222 dead-sandbox fixture", description: "" });
    const deadTask = await createTask(options, { roleId: deadRoleId, title: "dead", goal: "Run `pwd`.", requestedBy: "task-222-suite" });
    const deadThreadResult = await pool.query<{ id: string }>(
      `INSERT INTO threads (role_id) VALUES ($1) RETURNING id`,
      [deadRoleId],
    );
    await upsertRoleSandbox(options, { roleId: deadRoleId, sandboxId: "task-222-dead", state: "Paused", execdTokenRef: "secret://opensandbox/execd_access_token" });

    try {
      await expect(
        createChatRunDriver({ ...options, sandboxClient: unreachableClient }).run({
          task: deadTask,
          threadId: deadThreadResult.rows[0]!.id,
        }),
      ).rejects.toThrow(/sandbox not found/);
    } finally {
      await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [deadRoleId]);
      await pool.query("DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [deadRoleId]);
      await pool.query("DELETE FROM messages WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [deadRoleId]);
      await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [deadRoleId]);
      await pool.query("DELETE FROM role_sandboxes WHERE role_id = $1", [deadRoleId]);
      await pool.query("DELETE FROM tasks WHERE role_id = $1", [deadRoleId]);
      await pool.query("DELETE FROM threads WHERE role_id = $1", [deadRoleId]);
      await pool.query("DELETE FROM roles WHERE role_id = $1", [deadRoleId]);
    }
  });

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
          // Driver-to-SDK seam: a real child process with the exact cwd/env
          // the driver handed the SDK. Node itself is the process (TASK-161)
          // so the proof does not depend on bash/bash.exe/WSL being on PATH.
          const { stdout } = await execFileAsync(
            process.execPath,
            [
              "-e",
              `process.stdout.write(process.cwd() + "\\n" + String(process.env[${JSON.stringify(secretName)}] ?? ""))`,
            ],
            {
              cwd: workspace,
              env: sdkOptions.env,
            },
          );
          const [reportedCwd, reportedSecret] = stdout.trimEnd().split(/\r?\n/, 2);
          expect(reportedCwd).toBe(workspace);
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

integration("createChatRunDriver — self-rename governed MCP run (TASK-167)", () => {
  const roleId = "task-167-chat-self-rename";
  let pool: Pool;
  let options: DatabaseOptions;
  let threadId: string;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [roleId]);
    await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM tasks WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM thread_members WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM role_grants WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    process.env.OIKONOMOS_CAPABILITIES_ENABLED = "true";
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(options, { roleId, name: "Before rename", title: "TASK-167 chat fixture", description: "TASK-167 real governed self-rename fixture." });
    const database = new Database(options);
    try {
      await database.upsertCapability({ capabilityId: "workspace.rename_self", description: "Rename the calling bot's own display name.", defaultTier: "T1_draft", adapter: "mcp:workspace", enabled: true });
      await database.upsertRoleGrant({ roleId, capabilityId: "workspace.rename_self", maxTier: "T1_draft", constraints: {} });
    } finally { await database.close(); }
    threadId = (await pool.query<{ id: string }>("INSERT INTO threads (role_id) VALUES ($1) RETURNING id", [roleId])).rows[0]!.id;
  });

  afterAll(async () => { await cleanup(); await pool.end(); });

  it("lets a granted agent call rename_self and persists its own real name", async () => {
    const renamedTo = "The Conversation Bot";
    const queryFn: AgentSdkQueryFn = async function* (input) {
      const sdkOptions = input.options as { allowedTools?: readonly string[]; mcpServers?: Record<string, unknown> };
      expect(input.prompt).toContain("call yourself");
      expect(sdkOptions.mcpServers?.workspace).toBeDefined();
      expect(sdkOptions.allowedTools).toContain("mcp__workspace__rename_self(*)");
      expect(await callMountedTool(input, "mcp__workspace__rename_self", "task-167-granted", { name: renamedTo })).toBe(true);
      const response = await handleWorkspaceMcpRequest(JSON.stringify({
        jsonrpc: "2.0", id: "task-167-rename", method: "tools/call",
        params: { name: "rename_self", arguments: { name: renamedTo } },
      }), { connectionString: connectionString!, tenantId: "basileia", fromRoleId: roleId });
      expect(response).toMatchObject({ result: { content: [{ text: expect.stringContaining(renamedTo) }] } });
      yield { type: "result", result: `I will call myself ${renamedTo}.` };
    };
    const task = await createTask(options, { roleId, title: "TASK-167 self rename", goal: "Please call yourself The Conversation Bot.", requestedBy: "task-167-suite" });
    await createChatRunDriver({ ...options, queryFn }).run({ task, threadId });
    expect((await pool.query<{ name: string }>("SELECT name FROM roles WHERE role_id = $1", [roleId])).rows).toEqual([{ name: renamedTo }]);
    const run = (await listRuns(options, { taskId: task.taskId })).runs[0]!;
    const events = await getAuditEventsForRun(options, run.runId);
    expect(events.find((event) => event.eventType === "policy.decision" && event.capability === "workspace.rename_self")).toMatchObject({ payload: { verdict: "allow", toolName: "mcp__workspace__rename_self" } });
  });
});

integration("createChatRunDriver — live context compaction (TASK-193)", () => {
  const roleId = "task-193-context-compaction";
  let pool: Pool;
  let options: DatabaseOptions;
  let threadId: string;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM thread_summaries WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM thread_context WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM spend_records WHERE run_id IN (SELECT run_id::text FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [roleId]);
    await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [roleId]);
    await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM tasks WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM thread_members WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM role_grants WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(options, {
      roleId,
      name: "Context Compactor",
      title: "TASK-193 fixture",
      description: "Exercises the real post-run compaction call site.",
    });
    threadId = (await getOrCreateThreadForRole(options, { roleId })).id;
    const oversizedTurn = "x".repeat(1_000);
    for (let index = 0; index < 41; index += 1) {
      await insertMessage(options, { threadId, role: "user", body: `${index}:${oversizedTurn}` });
    }
  });

  afterAll(async () => { await cleanup(); await pool.end(); });

  it("persists a summary and visible system message after a real completed chat run", async () => {
    const queryFn: AgentSdkQueryFn = async function* () {
      yield { type: "result", result: "The final chat response." };
    };
    const task = await createTask(options, {
      roleId,
      title: "TASK-193 compaction fixture",
      goal: "Reply briefly.",
      requestedBy: "task-193-suite",
    });
    await createChatRunDriver({
      ...options,
      queryFn,
      tierZeroProviderOptions: {
        endpoint: "http://task-193.invalid/v1/chat/completions",
        model: "task-193-fixture-model",
        fetch: async () => new Response(JSON.stringify({
          choices: [{ message: { content: "A compacted factual summary." } }],
          usage: { cost_usd: 0.0001 },
        }), { status: 200, headers: { "content-type": "application/json" } }),
      },
    }).run({ task, threadId });

    expect((await pool.query("SELECT body FROM thread_summaries WHERE thread_id = $1", [threadId])).rows).toEqual([
      { body: "A compacted factual summary." },
    ]);
    expect((await listMessages(options, threadId)).some((message) => message.role === "system" && message.body.startsWith("Context compacted ("))).toBe(true);
    expect((await pool.query("SELECT count(*) FROM spend_records WHERE run_id IN (SELECT run_id::text FROM runs WHERE task_id = $1)", [task.taskId])).rows[0]?.count).toBe("1");
  });
});

// TASK-204 — G-06b browser lane live-wiring. TASK-186 (G-06a) proved
// steelSession.ts/browserLane.ts standalone; this suite proves the four
// live-execution properties that connector-layer-only task explicitly could
// not: AC1 (office-browser image selection), AC2 (browser.* tools reach the
// real mounted/allowed-tools surface), AC3 (a real governed Read of the
// sealed profile directory is denied and audited — the D3 guard TASK-186
// deferred), and AC4 (a human_takeover_required signal parks the run via a
// real, persisted event instead of failing it).
// TASK-207 Blocking-1 (Fable review of d44e64a): this fixture's tools MUST
// mirror packages/connectors/manifests/steel-browser.yaml's own declared
// set exactly. Once a tool is registered against the real shared DB (which
// register-capabilities does the moment the manifest gains it), any test
// that builds a full CapabilityRegistry from a fixture missing that tool
// hits C6's stale-row check (`StaleCapabilityRowError`) — this is exactly
// how the drift here (missing steel_session_create/steel_session_release)
// broke every describe block below, not just the browser-specific ones.
const steelBrowserManifest: ConnectorManifest = {
  connector_id: "steel-browser",
  account_ownership: "basileia",
  mcp_server: { name: "steel", transport: "remote", url_ref: "secret://mcp/steel-browser/url" },
  tools: [
    { tool_name: "mcp__steel__steel_session_create", capability_id: "browser.session", default_tier: "T1_draft" },
    { tool_name: "mcp__steel__steel_session_release", capability_id: "browser.session", default_tier: "T1_draft" },
    { tool_name: "mcp__steel__steel_navigate", capability_id: "browser.navigate", default_tier: "T1_draft" },
    { tool_name: "mcp__steel__steel_snapshot", capability_id: "browser.read", default_tier: "T0_observe" },
    { tool_name: "mcp__steel__steel_act", capability_id: "browser.interact", default_tier: "T2_internal" },
    { tool_name: "mcp__steel__steel_screenshot", capability_id: "browser.screenshot", default_tier: "T0_observe" },
  ],
  role_grants: [],
  evals: { suite: "evals/golden/suites/steel-browser", min_pass_rate: 0.9 },
  review: { onboarded_by: "test", date: "2026-09-07", scope_justification: "TASK-204 fixture" },
};

integration("createChatRunDriver — browser lane live-wiring (TASK-204)", () => {
  const roleId = "task-204-browser-lane";
  let pool: Pool;
  let options: DatabaseOptions;
  let threadId: string;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM role_sandboxes WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [roleId]);
    await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [roleId]);
    await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM tasks WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM thread_members WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM role_grants WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    process.env.OIKONOMOS_CAPABILITIES_ENABLED = "true";
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(options, { roleId, name: roleId, title: "TASK-204 browser lane fixture", description: "TASK-204 browser lane live-wiring fixture." });
    const database = new Database(options);
    try {
      await database.upsertCapability({ capabilityId: "browser.navigate", description: "Navigate the browser.", defaultTier: "T1_draft", adapter: "mcp:steel-browser", enabled: true });
      await database.upsertCapability({ capabilityId: "browser.read", description: "Read the current browser page.", defaultTier: "T0_observe", adapter: "mcp:steel-browser", enabled: true });
      await database.upsertRoleGrant({ roleId, capabilityId: "browser.navigate", maxTier: "T1_draft", constraints: {} });
      await database.upsertRoleGrant({ roleId, capabilityId: "browser.read", maxTier: "T0_observe", constraints: {} });
    } finally { await database.close(); }
    threadId = (await getOrCreateThreadForRole(options, { roleId })).id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    delete process.env.OIKONOMOS_CAPABILITIES_ENABLED;
  });

  // TASK-207 re-review (Fable 5.1): a comment is not a structural guard — on
  // a clean DB the C6 stale-row check this fixture drifted from never
  // fires, so drift stays invisible until someone registers the manifest.
  // This makes drift a build failure instead.
  it("keeps steelBrowserManifest's tools in exact sync with the real steel-browser.yaml manifest", async () => {
    const realManifest = (await loadManifests(defaultManifestsDir())).find((manifest) => manifest.connector_id === "steel-browser");
    expect(steelBrowserManifest.tools).toEqual(realManifest?.tools);
  });

  it("selects the office-browser sandbox image (not office-base) for a role granted browser.* capabilities (AC1)", async () => {
    let requestedImageUri: string | undefined;
    let requestedEntrypoint: readonly string[] | undefined;
    let state: "Running" | "Paused" = "Running";
    const fakeSandbox: SandboxClient = {
      health: async () => ({ status: "ok" }),
      createSandbox: async (spec: { image: { uri: string }; entrypoint?: readonly string[] }) => {
        requestedImageUri = spec.image.uri;
        requestedEntrypoint = spec.entrypoint;
        return { id: "task-204-office", createdAt: "2026-09-07T00:00:00Z", status: { state } };
      },
      getSandbox: async () => ({ id: "task-204-office", createdAt: "2026-09-07T00:00:00Z", status: { state } }),
      destroySandbox: async () => undefined,
      pauseSandbox: async () => { state = "Paused"; },
      resumeSandbox: async () => { state = "Running"; },
      getEndpoint: async () => ({ endpoint: "http://execd.test/204" }),
      ping: async () => undefined,
      runCommand: async (_endpoint: SandboxEndpoint, command: { command: string }) => {
        if (command.command.startsWith("/usr/bin/sha256sum")) {
          return { stdout: "886c6ad71724d395fd4600dd8cc0625df68686808409d6657fab8e9737083854  /etc/claude-code/managed-settings.json\n", stderr: "", exitCode: 0 };
        }
        if (command.command === "test -f /run/oikonomos/egress-policy-applied") return { stdout: "", stderr: "", exitCode: 0 };
        if (command.command.startsWith("mkdir")) return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: JSON.stringify({ type: "result", result: "sandboxed browser turn" }), stderr: "", exitCode: 0 };
      },
    } as unknown as SandboxClient;

    const previousBrokerUrl = process.env.OIK_SANDBOX_BROKER_URL;
    const previousSigningKey = process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY;
    const anthropicVar = ["OIK_SECRET_ANTHROPIC", "API_KEY"].join("_");
    const previousAnthropic = process.env[anthropicVar];
    process.env.OIK_SANDBOX_BROKER_URL = "http://broker.test:3001";
    process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = "task-204-test-signing-key";
    process.env[anthropicVar] = "task-204-test-anthropic-credential";
    try {
      const task = await createTask(options, { roleId, title: "TASK-204 sandbox image fixture", goal: "Open a page.", requestedBy: "task-204-suite" });
      await createChatRunDriver({
        ...options,
        manifests: [steelBrowserManifest],
        sandboxClient: fakeSandbox,
        platformCeilingZar: 1_000_000,
      }).run({ task, threadId });
      expect(requestedImageUri).toBe("oikonomos-office-browser:claude-2.1.263");
      // TASK-208: the office-browser image must be created with its OWN
      // Steel-starting wrapper, not the base image's. Without this the
      // container comes up with no Steel process and every steel_* tool
      // fails with "Could not reach Steel at http://localhost:3000".
      expect(requestedEntrypoint).toEqual(["/opt/oikonomos/browser-entrypoint.sh", "tail", "-f", "/dev/null"]);
    } finally {
      if (previousBrokerUrl === undefined) delete process.env.OIK_SANDBOX_BROKER_URL; else process.env.OIK_SANDBOX_BROKER_URL = previousBrokerUrl;
      if (previousSigningKey === undefined) delete process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY; else process.env.OIK_SECRET_BROKER_TOKEN_SIGNING_KEY = previousSigningKey;
      if (previousAnthropic === undefined) delete process.env[anthropicVar]; else process.env[anthropicVar] = previousAnthropic;
    }
  }, 30_000);

  it("mounts only the role's granted, enabled steel tools onto the real governed local surface (AC2)", async () => {
    const queryFn: AgentSdkQueryFn = async function* (input) {
      const sdkOptions = input.options as { allowedTools?: readonly string[]; mcpServers?: Record<string, unknown> };
      if (sdkOptions.mcpServers?.steel === undefined) throw new Error("TASK-204 fixture expected steel to be mounted");
      expect(sdkOptions.allowedTools).toContain("mcp__steel__steel_navigate(*)");
      expect(sdkOptions.allowedTools).not.toContain("mcp__steel__steel_act(*)");
      expect(await callMountedTool(input, "mcp__steel__steel_navigate", "task-204-navigate", { url: "https://example.test" })).toBe(true);
      yield { type: "tool_result", toolName: "mcp__steel__steel_navigate", result: "navigated" };
    };
    const task = await createTask(options, { roleId, title: "TASK-204 mount fixture", goal: "Navigate to example.test.", requestedBy: "task-204-suite" });
    await createChatRunDriver({ ...options, manifests: [steelBrowserManifest], queryFn }).run({ task, threadId });
    const run = (await listRuns(options, { taskId: task.taskId })).runs[0]!;
    expect(run.status).toBe("completed");
    const events = await getAuditEventsForRun(options, run.runId);
    expect(events.find((event) => event.eventType === "policy.decision" && event.capability === "browser.navigate"))
      .toMatchObject({ tier: "T1_draft", payload: { verdict: "allow", toolName: "mcp__steel__steel_navigate" } });
  });

  it("denies a real governed Read of the sealed browser profile directory and records the denial (AC3)", async () => {
    const sealedProfilePath = `/oikonomos/secrets/browser-profiles/${roleId}`;
    const queryFn: AgentSdkQueryFn = async function* (input) {
      expect(await callMountedTool(input, "Read", "task-204-read-sealed", { file_path: sealedProfilePath })).toBe(false);
      yield { type: "tool_result", toolName: "Read", result: "denied" };
    };
    const task = await createTask(options, { roleId, title: "TASK-204 sealed profile fixture", goal: "Read the browser profile.", requestedBy: "task-204-suite" });
    await createChatRunDriver({ ...options, manifests: [steelBrowserManifest], queryFn }).run({ task, threadId });
    const run = (await listRuns(options, { taskId: task.taskId })).runs[0]!;
    const events = await getAuditEventsForRun(options, run.runId);
    expect(events.find((event) => event.eventType === "policy.decision" && event.payload?.toolName === "Read"))
      .toMatchObject({ payload: { verdict: "deny", reason: "secret_path.sealed", toolName: "Read" } });
  });

  it("parks (not fails) on a human_takeover_required signal and records a real, persisted event (AC4)", async () => {
    class FixtureHumanTakeoverRequiredError extends Error {
      readonly code = "HUMAN_TAKEOVER_REQUIRED";
      constructor(readonly kind: string, readonly detail: string) {
        super(`human takeover required: ${kind}`);
        this.name = "HumanTakeoverRequiredError";
      }
    }
    // A single navigate result, then the typed signal — no second query/tool
    // attempt follows it (the generator ends via throw), matching "zero
    // further browser actions after" directly, by construction.
    const queryFn: AgentSdkQueryFn = async function* () {
      yield { type: "tool_result", toolName: "mcp__steel__steel_navigate", result: "hit a login wall" };
      throw new FixtureHumanTakeoverRequiredError("login_wall", "detected login wall page");
    };
    const task = await createTask(options, { roleId, title: "TASK-204 human takeover fixture", goal: "Log in to the portal.", requestedBy: "task-204-suite" });
    await createChatRunDriver({ ...options, manifests: [steelBrowserManifest], queryFn }).run({ task, threadId });

    const run = (await listRuns(options, { taskId: task.taskId })).runs[0]!;
    expect(run.status).toBe("waiting_approval");
    expect(run.endedAt).toBeNull();
    const events = await getAuditEventsForRun(options, run.runId);
    expect(events.find((event) => event.eventType === "run.human_takeover_required"))
      .toMatchObject({ payload: { kind: "login_wall", detail: "detected login wall page" } });
  });
});

