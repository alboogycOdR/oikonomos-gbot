/** The minimal persisted role-grant shape required for a pure egress decision. */
export interface EgressRoleGrant {
  readonly capabilityId: string;
  readonly constraints: Readonly<Record<string, unknown>>;
}

export interface EgressRole {
  readonly roleId: string;
  readonly grants: readonly EgressRoleGrant[];
}

/** Structural manifest view prevents this pure package from importing connector I/O. */
export interface EgressManifest {
  readonly tools: readonly { readonly capability_id: string }[];
  readonly network_hosts?: readonly string[];
}

export type EgressPolicyMode = "allow_all" | "defaults_plus_allowlist" | "allowlist_only";

export interface EgressPolicy {
  readonly mode: EgressPolicyMode;
  readonly hosts: readonly string[];
}

function domainsFrom(grant: EgressRoleGrant): readonly string[] | undefined {
  const value = grant.constraints.domains;
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function strictEgress(grant: EgressRoleGrant): boolean {
  return grant.constraints.strictEgress === true;
}

function normalizedHosts(hosts: readonly string[]): readonly string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0))].sort();
}

/** Purely resolves G-08's three executable modes from persisted grant data. */
export function resolveEgressPolicy(role: EgressRole, manifests: readonly EgressManifest[]): EgressPolicy {
  const explicit = role.grants.flatMap((grant) => domainsFrom(grant) ?? []);
  const hasDomains = role.grants.some((grant) => domainsFrom(grant) !== undefined);
  if (!hasDomains) return { mode: "allow_all", hosts: [] };
  if (role.grants.some(strictEgress)) return { mode: "allowlist_only", hosts: normalizedHosts(explicit) };
  const grantedCapabilities = new Set(role.grants.map((grant) => grant.capabilityId));
  const defaults = manifests
    .filter((manifest) => manifest.tools.some((tool) => grantedCapabilities.has(tool.capability_id)))
    .flatMap((manifest) => manifest.network_hosts ?? []);
  return { mode: "defaults_plus_allowlist", hosts: normalizedHosts([...defaults, ...explicit]) };
}
