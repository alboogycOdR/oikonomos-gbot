import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { handlePreToolUse, type BrokerDependencies, type PreToolUseRequest } from "./index.js";
import { BUILTIN_TOOLS } from "./builtinTools.js";
import {
  CapabilityNotRegisteredError,
  CapabilityOwnershipError,
  CapabilityEnabledDriftError,
  CapabilityRegistry,
  CapabilityTierDriftError,
  DuplicateToolDeclarationError,
  InvalidToolDeclarationError,
  StaleCapabilityRowError,
  UnobservableCapabilityRegistryError,
  declaredToolsFromManifest,
  type DeclaredTool,
  type PersistedCapability,
  type PersistedCapabilityReader,
} from "./capabilityRegistry.js";

const gmail: DeclaredTool = {
  toolName: "mcp__gmail__list_messages", capabilityId: "email.list", defaultTier: "T0_observe", adapter: "mcp:gmail", enabled: true, mcpServerName: "gmail",
};

function reader(rows: readonly PersistedCapability[], grants = new Map<string, "T0_observe" | "T1_draft" | "T2_internal" | "T3_external" | "T4_irreversible">()): PersistedCapabilityReader {
  return {
    listCapabilities: vi.fn(async () => rows),
    getCapability: vi.fn(async (id) => rows.find((row) => row.capabilityId === id) ?? null),
    getRoleGrant: vi.fn(async (roleId, capabilityId) => {
      const maxTier = grants.get(`${roleId}:${capabilityId}`);
      return maxTier === undefined ? null : { maxTier };
    }),
  };
}

function rowsFor(declared: readonly DeclaredTool[]): PersistedCapability[] {
  return [...new Map(declared.map((entry) => [entry.capabilityId, {
    capabilityId: entry.capabilityId, defaultTier: entry.defaultTier, adapter: entry.adapter, enabled: entry.enabled,
  }])).values()];
}

describe("CapabilityRegistry construction closure", () => {
  it("C1 throws DuplicateToolDeclarationError with the offending tool", async () => {
    await expect(CapabilityRegistry.build({ declared: [gmail, gmail], persisted: reader(rowsFor([gmail])) }))
      .rejects.toThrow(DuplicateToolDeclarationError);
    await expect(CapabilityRegistry.build({ declared: [gmail, gmail], persisted: reader(rowsFor([gmail])) }))
      .rejects.toThrow(gmail.toolName);
  });

  it("C2 throws InvalidToolDeclarationError with the offending tool", async () => {
    const invalid = { ...gmail, toolName: "mcp__other__list_messages" };
    await expect(CapabilityRegistry.build({ declared: [invalid], persisted: reader(rowsFor([invalid])) }))
      .rejects.toThrow(InvalidToolDeclarationError);
    await expect(CapabilityRegistry.build({ declared: [invalid], persisted: reader(rowsFor([invalid])) }))
      .rejects.toThrow(invalid.toolName);
  });

  it("C2 compares connector server names exactly without restricting valid raw tool suffixes", async () => {
    const valid = { ...gmail, toolName: "mcp__gmail__list-messages.v2" };
    await expect(CapabilityRegistry.build({ declared: [valid], persisted: reader(rowsFor([valid])) }))
      .resolves.toBeInstanceOf(CapabilityRegistry);
  });

  it("C3 throws CapabilityNotRegisteredError with the missing capability", async () => {
    await expect(CapabilityRegistry.build({ declared: [gmail], persisted: reader([]) }))
      .rejects.toThrow(CapabilityNotRegisteredError);
    await expect(CapabilityRegistry.build({ declared: [gmail], persisted: reader([]) }))
      .rejects.toThrow(gmail.capabilityId);
  });

  it("C4 throws CapabilityOwnershipError with the mismatched capability", async () => {
    const rows = [{ ...rowsFor([gmail])[0]!, adapter: "mcp:other" }];
    await expect(CapabilityRegistry.build({ declared: [gmail], persisted: reader(rows) }))
      .rejects.toThrow(CapabilityOwnershipError);
    await expect(CapabilityRegistry.build({ declared: [gmail], persisted: reader(rows) }))
      .rejects.toThrow(gmail.capabilityId);
  });

  it("C5 throws CapabilityTierDriftError with the drifted capability", async () => {
    const rows = [{ ...rowsFor([gmail])[0]!, defaultTier: "T1_draft" as const }];
    await expect(CapabilityRegistry.build({ declared: [gmail], persisted: reader(rows) }))
      .rejects.toThrow(CapabilityTierDriftError);
    await expect(CapabilityRegistry.build({ declared: [gmail], persisted: reader(rows) }))
      .rejects.toThrow(gmail.capabilityId);
  });

  it("throws CapabilityEnabledDriftError for enabled-state drift in either direction", async () => {
    const declaredDisabled = { ...gmail, enabled: false };
    await expect(CapabilityRegistry.build({
      declared: [gmail], persisted: reader([{ ...rowsFor([gmail])[0]!, enabled: false }]),
    })).rejects.toThrow(CapabilityEnabledDriftError);
    await expect(CapabilityRegistry.build({
      declared: [declaredDisabled], persisted: reader([{ ...rowsFor([declaredDisabled])[0]!, enabled: true }]),
    })).rejects.toThrow(CapabilityEnabledDriftError);
  });

  it("C6 throws StaleCapabilityRowError with the stale capability", async () => {
    const rows = [...rowsFor([gmail]), { capabilityId: "email.stale", defaultTier: "T0_observe" as const, adapter: "mcp:gmail", enabled: true }];
    await expect(CapabilityRegistry.build({ declared: [gmail], persisted: reader(rows) }))
      .rejects.toThrow(StaleCapabilityRowError);
    await expect(CapabilityRegistry.build({ declared: [gmail], persisted: reader(rows) }))
      .rejects.toThrow("email.stale");
  });

  it("C7 throws UNOBSERVABLE for an empty declaration surface", async () => {
    await expect(CapabilityRegistry.build({ declared: [], persisted: reader([]) }))
      .rejects.toThrow(UnobservableCapabilityRegistryError);
    await expect(CapabilityRegistry.build({ declared: [], persisted: reader([]) }))
      .rejects.toThrow("UNOBSERVABLE");
  });
});

describe("CapabilityRegistry resolution ports", () => {
  it("uses an exact, synchronous raw-name lookup", async () => {
    const registry = await CapabilityRegistry.build({ declared: [gmail], persisted: reader(rowsFor([gmail])) });
    expect(registry.resolve(gmail.toolName)).toEqual(gmail);
    expect(registry.resolve(`${gmail.toolName} `)).toBeNull();
    expect(registry.resolve(gmail.toolName.toUpperCase())).toBeNull();
  });

  it("projects manifests without reading files and defaults enabled to true", () => {
    expect(declaredToolsFromManifest({
      connector_id: "gmail", mcp_server: { name: "gmail" },
      tools: [{ tool_name: gmail.toolName, capability_id: gmail.capabilityId, default_tier: gmail.defaultTier }],
    })).toEqual([gmail]);
  });

  it("reads enabled and tier state per call, denying disabled, drifted, and missing rows", async () => {
    const store = reader(rowsFor([gmail]));
    const registry = await CapabilityRegistry.build({ declared: [gmail], persisted: store });
    const ports = registry.brokerPorts(store);
    await expect(ports.getCapability(gmail.toolName)).resolves.toMatchObject({ capabilityId: gmail.capabilityId });

    vi.mocked(store.getCapability).mockResolvedValueOnce({ ...rowsFor([gmail])[0]!, enabled: false });
    await expect(ports.getCapability(gmail.toolName)).resolves.toBeNull();
    vi.mocked(store.getCapability).mockResolvedValueOnce({ ...rowsFor([gmail])[0]!, defaultTier: "T1_draft" });
    await expect(ports.getCapability(gmail.toolName)).resolves.toBeNull();
    vi.mocked(store.getCapability).mockResolvedValueOnce(null);
    await expect(ports.getCapability(gmail.toolName)).resolves.toBeNull();
    expect(store.getCapability).toHaveBeenCalledTimes(4);
  });

  it("propagates declared enforcement metadata to the real broker port", async () => {
    const enforced: DeclaredTool = {
      ...gmail,
      enforcementEnabled: true,
      enforcedActionClasses: ["E6_irreversible_role_mutation"],
    };
    const store = reader(rowsFor([enforced]));
    const registry = await CapabilityRegistry.build({ declared: [enforced], persisted: store });

    await expect(registry.brokerPorts(store).getCapability(enforced.toolName)).resolves.toMatchObject({
      enforcementEnabled: true,
      enforcedActionClasses: ["E6_irreversible_role_mutation"],
    });
  });

  it("keeps declared-disabled capabilities out of ports and mounts regardless of grants", async () => {
    const disabled = { ...gmail, capabilityId: "project.create_role", enabled: false };
    const store = reader(rowsFor([disabled]), new Map([[`manager:${disabled.capabilityId}`, "T4_irreversible"]]));
    const registry = await CapabilityRegistry.build({ declared: [disabled], persisted: store });
    const ports = registry.brokerPorts(store);

    await expect(ports.getCapability(disabled.toolName)).resolves.toBeNull();
    expect(ports.isCapabilityDeclaredDisabled?.(disabled.toolName)).toBe(true);
    expect(registry.enabledToolNames.has(disabled.toolName)).toBe(false);
    expect(store.getCapability).not.toHaveBeenCalled();
  });

  it("maps a persisted role grant exactly and preserves missing grants", async () => {
    const store = reader(rowsFor([gmail]), new Map([[`inbox-triage:${gmail.capabilityId}`, "T1_draft"]]));
    const registry = await CapabilityRegistry.build({ declared: [gmail], persisted: store });
    await expect(registry.brokerPorts(store).getRoleGrant("inbox-triage", gmail.capabilityId))
      .resolves.toEqual({ maxTier: "T1_draft" });
    await expect(registry.brokerPorts(store).getRoleGrant("none", gmail.capabilityId)).resolves.toBeNull();
  });
});

async function realManifestDeclarations(): Promise<DeclaredTool[]> {
  const names = ["gmail.yaml", "google-calendar.yaml", "google-drive.yaml"];
  const root = fileURLToPath(new URL("../../connectors/manifests/", import.meta.url));
  const manifests = await Promise.all(names.map(async (name) => {
    const raw = await readFile(`${root}${name}`, "utf8");
    const connectorId = /^connector_id:\s*(\S+)$/m.exec(raw)?.[1];
    const server = /^mcp_server:\s*\{\s*name:\s*([^,\s]+)/m.exec(raw)?.[1];
    if (connectorId === undefined || server === undefined) throw new Error(`Invalid real manifest fixture: ${name}`);
    const tools = [...raw.matchAll(/^  - tool_name:\s*(\S+)\r?\n    capability_id:\s*(\S+)\r?\n    default_tier:\s*(\S+)(?:\r?\n    enabled:\s*(true|false))?/gm)]
      .map((match) => ({
        tool_name: match[1]!, capability_id: match[2]!, default_tier: match[3]! as DeclaredTool["defaultTier"],
        ...(match[4] === undefined ? {} : { enabled: match[4] === "true" }),
      }));
    return { connector_id: connectorId, mcp_server: { name: server }, tools };
  }));
  return manifests.flatMap((manifest) => declaredToolsFromManifest(manifest));
}

function brokerDependencies(registry: CapabilityRegistry, persisted: PersistedCapabilityReader, events: unknown[]): BrokerDependencies {
  return {
    isCapabilitiesEnabled: () => true,
    ...registry.brokerPorts(persisted),
    destinationFor: () => "/workspace/inbox",
    issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
    consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
    issueApproval: vi.fn(), verifyAndConsume: vi.fn(),
    recordDecision: async (event) => { events.push(event); return { eventId: `audit-${events.length}` }; },
    manifestMap: registry.enabledToolNames,
  };
}

describe("ADR-013 liveness layer 2", () => {
  it("turns a real manifest mutation into a broker deny audit event", async () => {
    const manifests = await realManifestDeclarations();
    const declared = [...BUILTIN_TOOLS, ...manifests];
    const grants = new Map([["inbox-triage:email.list", "T1_draft" as const]]);
    const persisted = reader(rowsFor(declared), grants);
    const registry = await CapabilityRegistry.build({ declared, persisted });
    const request: PreToolUseRequest = {
      toolUseId: "liveness-1", runId: "11111111-1111-1111-1111-111111111111", roleId: "inbox-triage", tenantId: "basileia",
      toolName: gmail.toolName, input: { path: "/workspace/inbox" }, agentRef: { provider: "test", sessionRef: "test", isSubagent: false },
    };
    const allowedEvents: unknown[] = [];
    await expect(handlePreToolUse(request, brokerDependencies(registry, persisted, allowedEvents))).resolves.toMatchObject({ decision: "allow" });
    expect(allowedEvents).toEqual([expect.objectContaining({ verdict: "allow", capability: "email.list" })]);

    const mutated = declared.filter((entry) => entry.toolName !== gmail.toolName);
    const mutatedPersisted = reader(rowsFor(mutated), grants);
    const mutatedRegistry = await CapabilityRegistry.build({ declared: mutated, persisted: mutatedPersisted });
    const deniedEvents: unknown[] = [];
    await expect(handlePreToolUse({ ...request, toolUseId: "liveness-2" }, brokerDependencies(mutatedRegistry, mutatedPersisted, deniedEvents)))
      .resolves.toMatchObject({ decision: "deny", reason: "allowlist.miss" });
    expect(deniedEvents).toEqual([expect.objectContaining({ verdict: "deny", reason: "allowlist.miss" })]);
  });
});

describe("ADR-019 Invariant A declared-disabled L1 enforcement", () => {
  it("LIVENESS: denies a granted declared-disabled capability before the mount allowlist", async () => {
    const disabled = { ...gmail, capabilityId: "project.create_role", enabled: false };
    const persisted = reader(
      rowsFor([disabled]),
      new Map([[`manager:${disabled.capabilityId}`, "T4_irreversible"]]),
    );
    const registry = await CapabilityRegistry.build({ declared: [disabled], persisted });
    const events: unknown[] = [];
    const response = await handlePreToolUse({
      toolUseId: "declared-disabled-1", runId: "11111111-1111-1111-1111-111111111111", roleId: "manager", tenantId: "basileia",
      toolName: disabled.toolName, input: { path: "/workspace/inbox" }, agentRef: { provider: "test", sessionRef: "test", isSubagent: false },
    }, brokerDependencies(registry, persisted, events));

    expect(response).toMatchObject({ decision: "deny", reason: "capability.declared_disabled" });
    expect(events).toEqual([expect.objectContaining({ verdict: "deny", reason: "capability.declared_disabled" })]);
  });
});
