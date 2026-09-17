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
      { toolName: "mcp__workspace__retire_bot", capabilityId: "workspace.retire_bot", defaultTier: "T4_irreversible", adapter: "mcp:workspace", mcpServerName: "workspace", enabled: true },
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

  /**
   * DISCOVERED GAP (not introduced by this task, flagged for ORCH):
   * `enforcementEnabled` (packages/broker/src/index.ts:133) — the switch
   * that lets a T4_irreversible capability actually reach the approval
   * flow instead of the unconditional legacy `tier.irreversible` deny at
   * index.ts:704 — is never set to `true` anywhere in this codebase
   * (verified by search: only the type declaration and this one read site
   * exist). `workspace.retire_bot` is the FIRST T4_irreversible builtin/
   * workspace tool ever declared, so it is the first to actually exercise
   * this branch. Until a protected-path task wires enforcementEnabled
   * (packages/broker/src/capabilityRegistry.ts's getCapability, plus
   * whatever persists it), retire_bot is denied `tier.irreversible` for
   * EVERY caller regardless of grant — it cannot reach a human approval
   * prompt through the real broker today. This does not block TASK-282's
   * own acceptance criteria (declaration, dual-adapter parity, and the DB-
   * level retirement semantics are all real and tested independently of
   * this path — see workspaceTools.test.ts), but it does mean the tool is
   * not yet end-to-end live. This test pins that exact behaviour so a
   * future enforcementEnabled wiring task changes this assertion
   * deliberately rather than by surprise.
   */
  it("control: the same manager-bot grant, same real tool set, denies retire_bot with tier.irreversible while enabled (enforcementEnabled is unwired platform-wide)", async () => {
    const declared: readonly DeclaredTool[] = BUILTIN_TOOLS;
    const persistedRows: PersistedCapability[] = [
      ...new Map(declared.map((tool) => [tool.capabilityId, {
        capabilityId: tool.capabilityId, defaultTier: tool.defaultTier, adapter: tool.adapter, enabled: tool.enabled,
      }])).values(),
    ];
    const grants = new Map([["manager-bot:workspace.retire_bot", "T4_irreversible"]]);
    const persisted = reader(persistedRows, grants);
    const registry = await CapabilityRegistry.build({ declared, persisted });

    const request: PreToolUseRequest = {
      toolUseId: "task-282-manager-retire-2",
      runId: "11111111-1111-1111-1111-111111111111",
      roleId: "manager-bot",
      tenantId: "basileia",
      toolName: "mcp__workspace__retire_bot",
      input: { roleId: "some-other-bot" },
      agentRef: { provider: "test", sessionRef: "test", isSubagent: false },
    };
    const events: unknown[] = [];
    const response = await handlePreToolUse(request, brokerDependencies(registry, persisted, events));

    expect(response).not.toMatchObject({ decision: "deny", reason: "capability.declared_disabled" });
    expect(response).toMatchObject({ decision: "deny", reason: "tier.irreversible" });
  });
});
