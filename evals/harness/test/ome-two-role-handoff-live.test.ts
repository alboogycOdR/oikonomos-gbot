import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  Database,
  createRole,
  createTask,
  getAuditEventsForRun,
  getOrCreateThreadForRole,
  listRoleMessages,
  listRuns,
  type DatabaseOptions,
} from "@oikonomos/db";
import type { AgentSdkQueryFn, AgentSdkQueryInput } from "@oikonomos/harness-factory";
import { describe, expect, it } from "vitest";

import { resolve, writeMemoryFact } from "../../../packages/memory/src/index.js";
import { createChatRunDriver } from "../../../services/worker/src/chatRunDriver.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

interface WorkspaceServerConfig {
  readonly type: string;
  readonly command?: string;
  readonly args?: readonly string[];
}

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
  if (hook === undefined) throw new Error("TASK-141 expected the composed PreToolUse hook");
  const output = await hook(
    { hook_event_name: "PreToolUse", tool_name: toolName, tool_use_id: toolUseId, tool_input: toolInput } as never,
    toolUseId as never,
    { signal: new AbortController().signal } as never,
  ) as { hookSpecificOutput?: { permissionDecision?: string } };
  return output.hookSpecificOutput?.permissionDecision === "allow";
}

/** Use the exact stdio command mounted by the real chat driver, not a mailbox mock. */
async function callWorkspaceMcpTool(
  workspace: WorkspaceServerConfig,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (workspace.type !== "stdio" || workspace.command === undefined || workspace.args === undefined) {
    throw new Error("TASK-141 expected the workspace stdio MCP bridge to be mounted");
  }
  const command = workspace.command;
  const args = workspace.args;
  // Vitest imports the driver's TypeScript source, so its `import.meta.url`
  // resolves the mounted entrypoint under `src/`. Spawn the equivalent
  // already-built worker bridge, exactly as the production-built driver does.
  const executableArgs = args.map((arg, index) => index === 0
    ? arg.replace(/[\\/]src[\\/]workspaceMcpServer\.js$/, "/dist/workspaceMcpServer.js")
    : arg);
  return await new Promise<Record<string, unknown>>((resolveResponse, reject) => {
    const child = spawn(command, executableArgs, { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`workspace MCP bridge exited ${code}: ${stderr}`));
    });
    const lines = createInterface({ input: child.stdout });
    lines.once("line", (line) => {
      try {
        resolveResponse(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      } finally {
        lines.close();
        child.kill();
      }
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "task-141-handoff",
      method: "tools/call",
      params: { name: "send_to_role", arguments: arguments_ },
    })}\n`);
  });
}

integration("OME two-role handoff — live broker tool path (TASK-141)", () => {
  it("runs a governed sender-to-receiver handoff without transferring fact ACLs", async () => {
    const suffix = randomUUID();
    const tenantId = `task-141-${suffix}`;
    const senderRoleId = `task-141-sender-${suffix}`;
    const receiverRoleId = `task-141-receiver-${suffix}`;
    const impostorRoleId = `task-141-impostor-${suffix}`;
    const projectId = `task-141-project-${suffix}`;
    const factKey = "research.findings";
    const options: DatabaseOptions = { connectionString: connectionString! };
    const originalCapabilitiesEnabled = process.env.OIKONOMOS_CAPABILITIES_ENABLED;
    process.env.OIKONOMOS_CAPABILITIES_ENABLED = "true";

    try {
      await Promise.all([senderRoleId, receiverRoleId, impostorRoleId].map((roleId) => createRole(options, {
        roleId,
        tenantId,
        name: roleId,
        title: "TASK-141 live handoff fixture role",
      })));
      const database = new Database(options);
      try {
        await database.upsertCapability({
          capabilityId: "workspace.send_to_role",
          description: "Send an asynchronous role handoff.",
          defaultTier: "T1_draft",
          adapter: "mcp:workspace",
          enabled: true,
        });
        await database.upsertRoleGrant({
          roleId: senderRoleId,
          capabilityId: "workspace.send_to_role",
          maxTier: "T1_draft",
          constraints: {},
        });
      } finally {
        await database.close();
      }

      await writeMemoryFact(options, {
        tenantId,
        scope: "project",
        projectId,
        key: factKey,
        value: "Receiver-only project finding.",
        source: senderRoleId,
        visibleTo: [receiverRoleId],
      });
      expect(await resolve(options, { tenantId, roleId: senderRoleId, projectId }, factKey)).toBeNull();

      const senderQuery: AgentSdkQueryFn = async function* (input) {
        const sdkOptions = input.options as {
          allowedTools?: readonly string[];
          mcpServers?: Record<string, WorkspaceServerConfig>;
        };
        const workspace = sdkOptions.mcpServers?.workspace;
        expect(sdkOptions.allowedTools).toContain("mcp__workspace__send_to_role(*)");
        expect(await callMountedTool(input, "mcp__workspace__send_to_role", "task-141-granted", {
          toRoleId: receiverRoleId,
          body: "Research is ready for the receiving role.",
          handoffKind: "research.complete",
          factRef: { tenantId, scope: "project", projectId, key: factKey },
        })).toBe(true);
        const response = await callWorkspaceMcpTool(workspace!, {
          // This model-controlled value must not become the persisted sender.
          fromRoleId: impostorRoleId,
          toRoleId: receiverRoleId,
          body: "Research is ready for the receiving role.",
          handoffKind: "research.complete",
          factRef: { tenantId, scope: "project", projectId, key: factKey },
        });
        expect(response).toHaveProperty("result.content");
        yield { type: "tool_result", result: "handoff sent through workspace MCP" };
      };
      const receiverQuery: AgentSdkQueryFn = async function* () {
        yield { type: "result", result: "receiver run completed" };
      };

      const senderTask = await createTask(options, {
        roleId: senderRoleId,
        tenantId,
        title: "TASK-141 live sender",
        goal: "Send the typed handoff through the workspace tool.",
        requestedBy: "task-141-suite",
      });
      const receiverTask = await createTask(options, {
        roleId: receiverRoleId,
        tenantId,
        title: "TASK-141 live receiver",
        goal: "Read the arriving handoff under the receiving role identity.",
        requestedBy: "task-141-suite",
      });
      const senderThread = await getOrCreateThreadForRole(options, { roleId: senderRoleId });
      const receiverThread = await getOrCreateThreadForRole(options, { roleId: receiverRoleId });

      await createChatRunDriver({ ...options, queryFn: senderQuery }).run({ task: senderTask, threadId: senderThread.id });
      await createChatRunDriver({ ...options, queryFn: receiverQuery }).run({ task: receiverTask, threadId: receiverThread.id });

      const [persistedHandoff] = await listRoleMessages(options, { tenantId, toRoleId: receiverRoleId });
      expect(persistedHandoff).toMatchObject({
        fromRoleId: senderRoleId,
        toRoleId: receiverRoleId,
        handoffKind: "research.complete",
        factRef: { tenantId, scope: "project", projectId, key: factKey },
      });
      expect(persistedHandoff?.fromRoleId).not.toBe(impostorRoleId);

      const senderRun = (await listRuns(options, { taskId: senderTask.taskId })).runs[0];
      expect(senderRun).toBeDefined();
      const events = await getAuditEventsForRun(options, senderRun!.runId);
      expect(events.find((event) => event.eventType === "policy.decision" && event.capability === "workspace.send_to_role")).toMatchObject({
        payload: { verdict: "allow", toolName: "mcp__workspace__send_to_role" },
      });

      // The receiver can resolve the locator only because its pre-existing
      // fact ACL permits it; the sender and an unrelated role remain denied.
      expect((await resolve(options, { tenantId, roleId: receiverRoleId, projectId }, factKey))?.value).toBe("Receiver-only project finding.");
      expect(await resolve(options, { tenantId, roleId: senderRoleId, projectId }, factKey)).toBeNull();
      expect(await resolve(options, { tenantId, roleId: impostorRoleId, projectId }, factKey)).toBeNull();
    } finally {
      if (originalCapabilitiesEnabled === undefined) delete process.env.OIKONOMOS_CAPABILITIES_ENABLED;
      else process.env.OIKONOMOS_CAPABILITIES_ENABLED = originalCapabilitiesEnabled;
    }
  }, 120_000);
});
