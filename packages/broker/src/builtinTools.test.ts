import { describe, expect, it } from "vitest";

import { BUILTIN_TOOLS } from "./builtinTools.js";

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
    ]);
    expect(Object.isFrozen(BUILTIN_TOOLS)).toBe(true);
  });
});
