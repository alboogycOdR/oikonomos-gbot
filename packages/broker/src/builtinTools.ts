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
  {
    toolName: "mcp__workspace__create_bot",
    capabilityId: "workspace.create_bot",
    // TASK-282 — wraps the same createRoleWithDefaultCapabilities path the
    // human `POST /roles` route uses. External-facing (a new bot is an
    // observable, human-reviewable effect) and human-approvable, same tier
    // as the existing workspace.request_secret.
    defaultTier: "T3_external",
    adapter: "mcp:workspace",
    mcpServerName: "workspace",
    enabled: true,
  },
  {
    toolName: "mcp__workspace__retire_bot",
    capabilityId: "workspace.retire_bot",
    // TASK-282 — the most consequential action a bot can take on another
    // bot (removes it from active service; no destructive delete, but no
    // existing precedent tier to match either), so it gets the ceiling tier.
    defaultTier: "T4_irreversible",
    adapter: "mcp:workspace",
    mcpServerName: "workspace",
    enabled: true,
    enforcementEnabled: true,
    // Object.freeze below is shallow -- it freezes BUILTIN_TOOLS itself,
    // never this nested array literal -- so it must be frozen here, at its
    // own declaration, or it stays mutable at the true source regardless of
    // any defensive copy CapabilityRegistry.build makes downstream (found
    // by adversarial review, TASK-285).
    enforcedActionClasses: Object.freeze(["E6_irreversible_role_mutation"]),
  },
  { toolName: "mcp__project__list_board", capabilityId: "project.read", defaultTier: "T0_observe", adapter: "mcp:project", mcpServerName: "project", enabled: true },
  { toolName: "mcp__project__create_task", capabilityId: "project.task_write", defaultTier: "T2_internal", adapter: "mcp:project", mcpServerName: "project", enabled: true },
  { toolName: "mcp__project__update_task", capabilityId: "project.task_write", defaultTier: "T2_internal", adapter: "mcp:project", mcpServerName: "project", enabled: true },
  { toolName: "mcp__project__assign_task", capabilityId: "project.assign", defaultTier: "T2_internal", adapter: "mcp:project", mcpServerName: "project", enabled: true },
  { toolName: "mcp__project__register_artifact", capabilityId: "project.artifact_write", defaultTier: "T2_internal", adapter: "mcp:project", mcpServerName: "project", enabled: true },
  { toolName: "mcp__project__record_decision", capabilityId: "project.decision_write", defaultTier: "T2_internal", adapter: "mcp:project", mcpServerName: "project", enabled: true },
  { toolName: "mcp__project__request_grant", capabilityId: "project.request_grant", defaultTier: "T3_external", adapter: "mcp:project", mcpServerName: "project", enabled: false },
] as const satisfies readonly DeclaredTool[]);
