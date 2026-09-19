import { describe, expect, it } from "vitest";
import { handleProjectMcpRequest } from "./projectMcpServer.js";

describe("project MCP server", () => {
  it("lists exactly the six enabled project tools, with neither role nor grant verbs", async () => {
    const response = await handleProjectMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), { connectionString: "postgres://unused", tenantId: "t", fromRoleId: "r" });
    const names = ((response?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toEqual(["list_board", "create_task", "update_task", "assign_task", "register_artifact", "record_decision"]);
    expect(names.join(" ")).not.toMatch(/role|grant/);
  });
});
