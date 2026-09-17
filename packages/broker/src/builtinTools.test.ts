import { describe, expect, it } from "vitest";

import { BUILTIN_TOOLS } from "./builtinTools.js";
import { CapabilityRegistry, type DeclaredTool, type PersistedCapability, type PersistedCapabilityReader } from "./capabilityRegistry.js";
import { handlePreToolUse, type BrokerDependencies, type PreToolUseRequest } from "./index.js";

describe("BUILTIN_TOOLS", () => {
  it("is the ADR-013 reviewed table with its internal workspace MCP tool", () => {
    expect(BUILTIN_TOOLS).toEqual([
      { toolName: "Read", capabilityId: "fs.read", defaultTier: "T0_observe", adapter: "sdk:builtin", enabled: true },
      { toolName: "Glob", capabilityId: "fs.read", defaultTier: "T0_observe", adapter: "sdk:builtin", enabled: true },
      { toolName: "Grep", capabilityId: "fs.read", defaultTier: "T0_observe", adapter: "sdk:builtin", enabled: true },
      { toolName: "Edit", capabilityId: "fs.write", defaultTier: "T2_internal", adapter: "sdk:builtin", enabled: true },
      { toolName: "Write", capabilityId: "fs.write", defaultTier: "T2_internal", adapter: "sdk:builtin", enabled: true },
      { toolName: "Bash", capabilityId: "runtime.bash", defaultTier: "T3_external", adapter: "sdk:builtin", enabled: true },
      { toolName: "mcp__workspace__send_to_role", capabilityId: "workspace.send_to_role", defaultTier: "T1_draft", adapter: "mcp:workspace", mcpServerName: "workspace", enabled: true },
      { toolName: "mcp__workspace__rename_self", capabilityId: "workspace.rename_self", defaultTier: "T1_draft", adapter: "mcp:workspace", mcpServerName: "workspace", enabled: true },
      { toolName: "mcp__workspace__request_secret", capabilityId: "workspace.request_secret", defaultTier: "T3_external", adapter: "mcp:workspace", mcpServerName: "workspace", enabled: true },
      { toolName: "mcp__workspace__create_routine", capabilityId: "workspace.create_routine", defaultTier: "T1_draft", adapter: "mcp:workspace", mcpServerName: "workspace", enabled: true },
      { toolName: "mcp__workspace__create_bot", capabilityId: "workspace.create_bot", defaultTier: "T3_external", adapter: "mcp:workspace", mcpServerName: "workspace", enabled: true },
      { toolName: "mcp__workspace__retire_bot", capabilityId: "workspace.retire_bot", defaultTier: "T4_irreversible", adapter: "mcp:workspace", mcpServerName: "workspace", enabled: true, enforcementEnabled: true, enforcedActionClasses: ["E6_irreversible_role_mutation"] },
    ]);
    expect(Object.isFrozen(BUILTIN_TOOLS)).toBe(true);
  });
});

/**
 * TASK-282 AC1 — TASK-277's `CapabilityEnabledDriftError` /
 * `capability.declared_disabled` invariant (ADR-019 Invariant A) has only
 * ever been exercised in isolation, against a synthetic renamed `gmail` tool
 * (see `capabilityRegistry.test.ts`'s "ADR-019 Invariant A" suite). This
 * test proves it holds for the REAL manager-bot tools this task adds: a
 * role holding a manager-shaped grant on `workspace.retire_bot` is denied
 * with the specific per-capability reason `capability.declared_disabled`
 * (never the generic `capability.disabled` global kill-switch reason, and
 * never a silent allow) the moment that tool's declaration is disabled —
 * exactly what an operator kill-switching `workspace.retire_bot` via
 * `builtinTools.ts` would produce.
 */
describe("ADR-019 Invariant A — live in a real manager-bot scenario (TASK-282)", () => {
  function reader(rows: readonly PersistedCapability[], grants: Map<string, string>): PersistedCapabilityReader {
    return {
      listCapabilities: async () => rows,
      getCapability: async (id) => rows.find((row) => row.capabilityId === id) ?? null,
      getRoleGrant: async (roleId, capabilityId) => {
        const maxTier = grants.get(`${roleId}:${capabilityId}`);
        return maxTier === undefined ? null : { maxTier: maxTier as PersistedCapability["defaultTier"] };
      },
    };
  }

  function brokerDependencies(registry: CapabilityRegistry, persisted: PersistedCapabilityReader, events: unknown[]): BrokerDependencies {
    return {
      isCapabilitiesEnabled: () => true,
      ...registry.brokerPorts(persisted),
      destinationFor: () => "/workspace/roles",
      issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
      consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
      issueApproval: async () => ({
        reason: "approval_pending",
        approvalId: "unused",
        nonce: "unused",
        expiresAt: new Date(),
        actionDigest: "unused",
        actionRender: "unused",
        destination: "/workspace/roles",
        status: "pending",
      }),
      verifyAndConsume: async () => ({ consumed: false, rowCount: 0 }),
      recordDecision: async (event) => { events.push(event); return { eventId: `audit-${events.length}` }; },
      manifestMap: registry.enabledToolNames,
    };
  }

  it("denies a manager bot's retire_bot with capability.declared_disabled once the tool is declared-disabled, real drift scenario included", async () => {
    // The real declaration table, with retire_bot flipped to disabled — the
    // shape an operator kill-switch produces. Every other declared tool
    // (including the real create_bot) is untouched.
    const declared: readonly DeclaredTool[] = BUILTIN_TOOLS.map((tool) =>
      tool.toolName === "mcp__workspace__retire_bot" ? { ...tool, enabled: false } : tool,
    );
    const persistedRows: PersistedCapability[] = [
      ...new Map(declared.map((tool) => [tool.capabilityId, {
        capabilityId: tool.capabilityId, defaultTier: tool.defaultTier, adapter: tool.adapter, enabled: tool.enabled,
      }])).values(),
    ];
    // Real manager-bot shape: a grant exists at the tool's own ceiling tier,
    // exactly as a human operator would have configured before the kill
    // switch — proving the deny is the declared-disabled invariant, not a
    // missing-grant deny.
    const grants = new Map([["manager-bot:workspace.retire_bot", "T4_irreversible"]]);
    const persisted = reader(persistedRows, grants);

    // C5/Invariant-A construction guard: build() must accept this — declared
    // and persisted agree the tool is disabled, so this is NOT drift.
    const registry = await CapabilityRegistry.build({ declared, persisted });

    const request: PreToolUseRequest = {
      toolUseId: "task-282-manager-retire-1",
      runId: "11111111-1111-1111-1111-111111111111",
      roleId: "manager-bot",
      tenantId: "basileia",
      toolName: "mcp__workspace__retire_bot",
      input: { roleId: "some-other-bot" },
      agentRef: { provider: "test", sessionRef: "test", isSubagent: false },
    };
    const events: unknown[] = [];
    const response = await handlePreToolUse(request, brokerDependencies(registry, persisted, events));

    expect(response).toMatchObject({ decision: "deny", reason: "capability.declared_disabled" });
    expect(response).not.toMatchObject({ reason: "capability.disabled" });
    expect(events).toEqual([expect.objectContaining({ verdict: "deny", reason: "capability.declared_disabled" })]);
  });

  /** TASK-285 — fixed-floor enforcement must outrank every grant ceiling. */
  it("requires approval for retire_bot under every grant ceiling rather than using autonomous allow", async () => {
    const declared: readonly DeclaredTool[] = BUILTIN_TOOLS;
    const persistedRows: PersistedCapability[] = [
      ...new Map(declared.map((tool) => [tool.capabilityId, {
        capabilityId: tool.capabilityId, defaultTier: tool.defaultTier, adapter: tool.adapter, enabled: tool.enabled,
      }])).values(),
    ];
    for (const maxTier of ["T0_observe", "T1_draft", "T2_internal", "T3_external", "T4_irreversible"] as const) {
      const persisted = reader(persistedRows, new Map([["manager-bot:workspace.retire_bot", maxTier]]));
      const registry = await CapabilityRegistry.build({ declared, persisted });
      const response = await handlePreToolUse({
        toolUseId: `task-285-manager-retire-${maxTier}`,
        runId: "11111111-1111-1111-1111-111111111111",
        roleId: "manager-bot", tenantId: "basileia", toolName: "mcp__workspace__retire_bot",
        input: { roleId: "some-other-bot" }, agentRef: { provider: "test", sessionRef: "test", isSubagent: false },
      }, brokerDependencies(registry, persisted, []));

      expect(response).toMatchObject({ decision: "deny", reason: "approval_pending" });
      expect(response).not.toMatchObject({ decision: "allow" });
    }
  });
});
