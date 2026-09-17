import type { EnforcedActionClass, RiskTier } from "@oikonomos/policy";

import type { BrokerDependencies, RegisteredCapability, RoleGrantCeiling } from "./index.js";

export interface DeclaredTool {
  readonly toolName: string;
  readonly capabilityId: string;
  readonly defaultTier: RiskTier;
  readonly adapter: string;
  readonly enabled: boolean;
  /** Opts this declaration into the policy enforcement resolver. */
  readonly enforcementEnabled?: boolean;
  /** Fixed-floor classifications propagated to the broker at call time. */
  readonly enforcedActionClasses?: readonly EnforcedActionClass[];
  /** Connector server identity used only to close C2's raw SDK-name contract. */
  readonly mcpServerName?: string;
}

export interface ConnectorManifestSlice {
  readonly connector_id: string;
  readonly mcp_server: { readonly name: string };
  readonly tools: readonly {
    readonly tool_name: string;
    readonly capability_id: string;
    readonly default_tier: RiskTier;
    readonly enabled?: boolean;
  }[];
}

export interface PersistedCapability {
  readonly capabilityId: string;
  readonly defaultTier: RiskTier;
  readonly adapter: string;
  readonly enabled: boolean;
}

export interface PersistedRoleGrant {
  readonly maxTier: RiskTier;
  /**
   * TASK-227: the persisted `role_grants.constraints` JSONB, forwarded
   * (not narrowed) so `brokerPorts()` no longer silently drops it. Optional
   * so an older `PersistedCapabilityReader` implementation that never
   * returns it isn't broken.
   */
  readonly constraints?: Readonly<Record<string, unknown>>;
}

export interface PersistedCapabilityReader {
  getCapability(capabilityId: string): Promise<PersistedCapability | null>;
  getRoleGrant(roleId: string, capabilityId: string): Promise<PersistedRoleGrant | null>;
  listCapabilities(): Promise<readonly PersistedCapability[]>;
}

class RegistryError extends Error {
  public constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export class DuplicateToolDeclarationError extends RegistryError {
  public constructor(toolName: string) { super("DuplicateToolDeclarationError", `Duplicate declaration for tool '${toolName}'.`); }
}
export class InvalidToolDeclarationError extends RegistryError {
  public constructor(toolName: string) { super("InvalidToolDeclarationError", `Invalid declaration for tool '${toolName}'.`); }
}
export class CapabilityNotRegisteredError extends RegistryError {
  public constructor(capabilityId: string) { super("CapabilityNotRegisteredError", `Capability '${capabilityId}' is not registered; run register-capabilities.`); }
}
export class CapabilityOwnershipError extends RegistryError {
  public constructor(capabilityId: string) { super("CapabilityOwnershipError", `Capability '${capabilityId}' has an adapter ownership mismatch.`); }
}
export class CapabilityTierDriftError extends RegistryError {
  public constructor(capabilityId: string) { super("CapabilityTierDriftError", `Capability '${capabilityId}' has default tier drift.`); }
}
export class CapabilityEnabledDriftError extends RegistryError {
  public constructor(capabilityId: string) { super("CapabilityEnabledDriftError", `Capability '${capabilityId}' has enabled-state drift.`); }
}
export class StaleCapabilityRowError extends RegistryError {
  public constructor(capabilityId: string) { super("StaleCapabilityRowError", `Registered capability '${capabilityId}' has no declaration.`); }
}
export class UnobservableCapabilityRegistryError extends RegistryError {
  public constructor() { super("UNOBSERVABLE", "UNOBSERVABLE: zero capability declarations loaded."); }
}

const builtinToolName = /^[A-Za-z][A-Za-z0-9]*$/;

/** Projects validated connector manifest data into the broker's declaration form. */
export function declaredToolsFromManifest(slice: ConnectorManifestSlice): readonly DeclaredTool[] {
  return slice.tools.map((tool) => ({
    toolName: tool.tool_name,
    capabilityId: tool.capability_id,
    defaultTier: tool.default_tier,
    adapter: `mcp:${slice.connector_id}`,
    enabled: tool.enabled ?? true,
    mcpServerName: slice.mcp_server.name,
  }));
}

function isValidDeclaration(entry: DeclaredTool): boolean {
  if (entry.adapter === "sdk:builtin") {
    return !entry.toolName.startsWith("mcp__") && builtinToolName.test(entry.toolName);
  }
  if (!entry.adapter.startsWith("mcp:")) return false;
  const server = entry.mcpServerName;
  if (server === undefined || server.length === 0) return false;
  const prefix = `mcp__${server}__`;
  return entry.toolName.startsWith(prefix) && entry.toolName.length > prefix.length;
}

export interface CapabilityRegistryBuildInput {
  readonly declared: readonly DeclaredTool[];
  readonly persisted: PersistedCapabilityReader;
}

/** Process-level exact-name declaration resolver; it performs no I/O after build. */
export class CapabilityRegistry {
  readonly #entries: ReadonlyMap<string, DeclaredTool>;
  readonly enabledToolNames: ReadonlySet<string>;

  private constructor(entries: ReadonlyMap<string, DeclaredTool>) {
    this.#entries = entries;
    this.enabledToolNames = new Set(
      [...entries.values()].filter((entry) => entry.enabled).map((entry) => entry.toolName),
    );
  }

  public static async build(input: CapabilityRegistryBuildInput): Promise<CapabilityRegistry> {
    if (input.declared.length === 0) throw new UnobservableCapabilityRegistryError();
    const entries = new Map<string, DeclaredTool>();
    for (const entry of input.declared) {
      if (entries.has(entry.toolName)) throw new DuplicateToolDeclarationError(entry.toolName);
      if (!isValidDeclaration(entry)) throw new InvalidToolDeclarationError(entry.toolName);
      // `Object.freeze` is shallow: without also freezing `enforcedActionClasses`,
      // a caller holding a reference to a resolved entry could mutate the
      // SAME array `BUILTIN_TOOLS`'s own literal points at (found by
      // adversarial review, TASK-285) -- e.g. clearing it would silently
      // drop `workspace.retire_bot` to `default_autonomous` allow, process-
      // wide, for every future request, with no error anywhere.
      entries.set(entry.toolName, Object.freeze({
        ...entry,
        ...(entry.enforcedActionClasses === undefined ? {} : { enforcedActionClasses: Object.freeze([...entry.enforcedActionClasses]) }),
      }));
    }

    const rows = await input.persisted.listCapabilities();
    const rowsByCapability = new Map(rows.map((row) => [row.capabilityId, row]));
    for (const entry of entries.values()) {
      const row = rowsByCapability.get(entry.capabilityId);
      if (row === undefined) throw new CapabilityNotRegisteredError(entry.capabilityId);
      if (row.adapter !== entry.adapter) throw new CapabilityOwnershipError(entry.capabilityId);
      if (row.defaultTier !== entry.defaultTier) throw new CapabilityTierDriftError(entry.capabilityId);
      if (row.enabled !== entry.enabled) throw new CapabilityEnabledDriftError(entry.capabilityId);
    }

    const declaredAdapters = new Set([...entries.values()].map((entry) => entry.adapter));
    const declaredCapabilities = new Set([...entries.values()].map((entry) => entry.capabilityId));
    for (const row of rows) {
      if (declaredAdapters.has(row.adapter) && !declaredCapabilities.has(row.capabilityId)) {
        throw new StaleCapabilityRowError(row.capabilityId);
      }
    }
    return new CapabilityRegistry(entries);
  }

  /** Pure, synchronous raw-name lookup; deliberately no normalisation. */
  public resolve(toolName: string): DeclaredTool | null {
    return this.#entries.get(toolName) ?? null;
  }

  /** Per-call database adapters for the L1 broker boundary. */
  public brokerPorts(persisted: Pick<PersistedCapabilityReader, "getCapability" | "getRoleGrant">): Pick<BrokerDependencies, "getCapability" | "getRoleGrant" | "isCapabilityDeclaredDisabled"> {
    return {
      isCapabilityDeclaredDisabled: (toolName: string): boolean => this.resolve(toolName)?.enabled === false,
      getCapability: async (toolName: string): Promise<RegisteredCapability | null> => {
        const entry = this.resolve(toolName);
        if (entry === null || entry.enabled !== true) return null;
        const row = await persisted.getCapability(entry.capabilityId);
        if (row === null || row.enabled !== true || row.defaultTier !== entry.defaultTier || row.adapter !== entry.adapter) return null;
        return {
          toolName,
          capabilityId: entry.capabilityId,
          defaultTier: entry.defaultTier,
          // Conditional spread (adversarial review, TASK-285): a legacy
          // capability that never declares these fields must project a
          // RegisteredCapability with them genuinely ABSENT, not present
          // with value `undefined` -- keeps this object's shape identical
          // to what every pre-existing capability already produced.
          ...(entry.enforcementEnabled === undefined ? {} : { enforcementEnabled: entry.enforcementEnabled }),
          ...(entry.enforcedActionClasses === undefined ? {} : { enforcedActionClasses: entry.enforcedActionClasses }),
        };
      },
      getRoleGrant: async (roleId: string, capabilityId: string): Promise<RoleGrantCeiling | null> => {
        const row = await persisted.getRoleGrant(roleId, capabilityId);
        // TASK-227: previously dropped `constraints` here, which is why
        // `rate_per_hour` was persisted (real connector manifests, e.g.
        // gmail.yaml's inbox-triage grant) but never reached the broker.
        return row === null ? null : { maxTier: row.maxTier, constraints: row.constraints };
      },
    };
  }
}
