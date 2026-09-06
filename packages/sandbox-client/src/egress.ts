import type { NetworkPolicy } from "./types.js";

type EgressPolicy = {
  readonly mode: "allow_all" | "defaults_plus_allowlist" | "allowlist_only";
  readonly hosts: readonly string[];
};

/** Converts the pure product policy to OpenSandbox's v0.2.2 create shape. */
export function toOpenSandboxNetworkPolicy(policy: EgressPolicy): NetworkPolicy {
  if (policy.mode === "allow_all") return { defaultAction: "allow", egress: [] };
  return {
    defaultAction: "deny",
    egress: policy.hosts.map((target) => ({ action: "allow", target })),
  };
}
