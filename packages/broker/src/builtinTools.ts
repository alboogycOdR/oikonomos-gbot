import type { DeclaredTool } from "./capabilityRegistry.js";
import { REQUEST_SECRET_CAPABILITY_ID, REQUEST_SECRET_TOOL } from "./requestSecret.js";

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
  {
    toolName: "mcp__workspace__send_to_role",
    capabilityId: "workspace.send_to_role",
    defaultTier: "T1_draft",
    adapter: "mcp:workspace",
    mcpServerName: "workspace",
    enabled: true,
  },
  {
    toolName: "mcp__workspace__rename_self",
    capabilityId: "workspace.rename_self",
    // A bot can alter only its own display name; no third party or external effect.
    defaultTier: "T1_draft",
    adapter: "mcp:workspace",
    mcpServerName: "workspace",
    enabled: true,
  },
  {
    toolName: REQUEST_SECRET_TOOL,
    capabilityId: REQUEST_SECRET_CAPABILITY_ID,
    defaultTier: "T3_external",
    adapter: "mcp:workspace",
    mcpServerName: "workspace",
    enabled: true,
  },
  {
    toolName: "mcp__workspace__create_routine",
    capabilityId: "workspace.create_routine",
    // A routine creates no immediate side effect — it schedules FUTURE
    // work, and that work's own tool calls are re-gated by this same
    // broker when the routine actually fires (routineJob.ts's own poll
    // path is a normal task run). Draft-tier here, same as
    // send_to_role/rename_self: self-contained, no third-party or
    // external effect at creation time.
    defaultTier: "T1_draft",
    adapter: "mcp:workspace",
    mcpServerName: "workspace",
    enabled: true,
  },
] as const satisfies readonly DeclaredTool[]);
