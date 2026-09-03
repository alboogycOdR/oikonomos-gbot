import type { DeclaredTool } from "./capabilityRegistry.js";

/**
 * Reviewed declarations for the Agent SDK tools this process can mount.
 * Anything not listed here remains unregistered and therefore denied.
 */
export const BUILTIN_TOOLS = Object.freeze([
  { toolName: "Read", capabilityId: "fs.read", defaultTier: "T0_observe", adapter: "sdk:builtin", enabled: true },
  { toolName: "Glob", capabilityId: "fs.read", defaultTier: "T0_observe", adapter: "sdk:builtin", enabled: true },
  { toolName: "Grep", capabilityId: "fs.read", defaultTier: "T0_observe", adapter: "sdk:builtin", enabled: true },
  { toolName: "Edit", capabilityId: "fs.write", defaultTier: "T2_internal", adapter: "sdk:builtin", enabled: true },
  { toolName: "Write", capabilityId: "fs.write", defaultTier: "T2_internal", adapter: "sdk:builtin", enabled: true },
  { toolName: "Bash", capabilityId: "runtime.bash", defaultTier: "T3_external", adapter: "sdk:builtin", enabled: true },
] as const satisfies readonly DeclaredTool[]);
