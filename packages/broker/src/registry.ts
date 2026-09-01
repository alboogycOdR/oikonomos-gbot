/**
 * Construction-time policy completeness (TASK-066, study §Tier 1.4).
 *
 * Grok Bot's RPC edge throws at startup if any contract method lacks a
 * handler — "we forgot to gate the new tool" becomes a boot crash, not a
 * silent fail-open hole. Same idea here: given the tool names a harness
 * will mount, every name must map to a policy entry or constructing the
 * registry throws {@link PolicyMissingError} naming the tool.
 *
 * The throw IS the ADR-005 liveness assertion: a test that constructs the
 * broker with an unmapped tool and asserts the throw. If this constructor
 * is never called, that test is the evidence the control is inert.
 *
 * Bidirectional inventory closure (study §6.2 / TASK-066 AC): a policy
 * entry naming a tool that no connector manifest maps is a
 * {@link StalePolicyEntryError} at the same construction site.
 */

/** One policy table entry. Presence of the key is what construction checks. */
export interface ToolPolicyEntry {
  readonly toolName: string;
  readonly [key: string]: unknown;
}

export interface PolicyRegistryInput {
  /** Tool names the harness will mount. Every name must have a policy. */
  readonly mountedToolNames: readonly string[];
  /**
   * Policy table keyed by tool name. Construction throws if any mounted
   * name is absent ({@link PolicyMissingError}) or if any key is absent
   * from `manifestToolNames` ({@link StalePolicyEntryError}).
   */
  readonly policies:
    | Readonly<Record<string, unknown>>
    | ReadonlyMap<string, unknown>
    | readonly ToolPolicyEntry[];
  /**
   * Tool names currently mapped by connector manifests — the derived
   * allowedTools / manifest map, not a live enumeration cache.
   */
  readonly manifestToolNames: readonly string[];
}

/**
 * Raised when a harness-mounted tool has no policy entry. Naming the tool
 * is the whole point: the crash tells you which gate is missing.
 */
export class PolicyMissingError extends Error {
  readonly toolName: string;
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    const named = missing[0] ?? "<unknown>";
    super(
      missing.length === 1
        ? `Policy missing for mounted tool "${named}"`
        : `Policy missing for mounted tools: ${missing.map((name) => `"${name}"`).join(", ")}`,
    );
    this.name = "PolicyMissingError";
    this.toolName = named;
    this.missing = missing;
  }
}

/**
 * Raised when a policy entry names a tool that no connector manifest maps.
 * The leftover policy is inventory drift, not a live gate.
 */
export class StalePolicyEntryError extends Error {
  readonly toolName: string;
  readonly stale: readonly string[];

  constructor(stale: readonly string[]) {
    const named = stale[0] ?? "<unknown>";
    super(
      stale.length === 1
        ? `Stale policy entry "${named}" is not mapped by any manifest`
        : `Stale policy entries not mapped by any manifest: ${stale.map((name) => `"${name}"`).join(", ")}`,
    );
    this.name = "StalePolicyEntryError";
    this.toolName = named;
    this.stale = stale;
  }
}

function policyKeys(
  policies: PolicyRegistryInput["policies"],
): ReadonlyMap<string, unknown> {
  if (policies instanceof Map) {
    return policies;
  }
  if (Array.isArray(policies)) {
    const table = new Map<string, unknown>();
    for (const entry of policies) {
      if (typeof entry?.toolName === "string") {
        table.set(entry.toolName, entry);
      }
    }
    return table;
  }
  return new Map(Object.entries(policies));
}

function uniqueSorted(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Broker policy registry. Construct once at harness composition time;
 * pass {@link PolicyRegistry.manifestMap} as `BrokerDependencies.manifestMap`
 * so every PreToolUse call re-checks the same map (study §Tier 1.6).
 */
export class PolicyRegistry {
  readonly mountedToolNames: readonly string[];
  readonly policies: ReadonlyMap<string, unknown>;
  readonly manifestMap: ReadonlySet<string>;

  constructor(input: PolicyRegistryInput) {
    const mounted = uniqueSorted(
      (input.mountedToolNames ?? []).filter((name) => typeof name === "string"),
    );
    const table = policyKeys(input.policies ?? {});
    const manifest = new Set(
      (input.manifestToolNames ?? []).filter((name) => typeof name === "string" && name.length > 0),
    );

    const emptyMounted = mounted.filter((name) => name.length === 0);
    const missing = uniqueSorted([
      ...emptyMounted,
      ...mounted.filter((name) => name.length > 0 && !table.has(name)),
    ]);
    if (missing.length > 0) {
      // ADR-005 liveness: this throw is the control doing its job.
      throw new PolicyMissingError(missing);
    }

    const stale = uniqueSorted(
      [...table.keys()].filter((name) => name.length === 0 || !manifest.has(name)),
    );
    if (stale.length > 0) {
      throw new StalePolicyEntryError(stale);
    }

    this.mountedToolNames = Object.freeze([...mounted]);
    this.policies = table;
    this.manifestMap = manifest;
  }

  has(toolName: string): boolean {
    return this.manifestMap.has(toolName);
  }
}
