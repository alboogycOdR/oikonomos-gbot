import { describe, expect, it } from "vitest";

import type { Database } from "@oikonomos/db";
import {
  PROJECT_TOOL_CAPABILITIES,
  resolveGrantedProjectConnector,
} from "./connectorResolution.js";
import { createProjectGeminiTools } from "./geminiToolExecutors.js";

const enabledNames = PROJECT_TOOL_CAPABILITIES.map(([, name]) => name);
const disabledNames = ["mcp__project__create_role", "mcp__project__request_grant"];

function databaseFor(capabilities: readonly string[]): Database {
  return { listRoleGrants: async () => capabilities.map((capabilityId) => ({ capabilityId })) } as unknown as Database;
}

describe("project manager MCP mount (TASK-303)", () => {
  it("mounts exactly the six enabled project tools for a manager in Claude and Gemini, never declared-disabled tools", async () => {
    const connector = await resolveGrantedProjectConnector({
      database: databaseFor(PROJECT_TOOL_CAPABILITIES.map(([capability]) => capability)),
      connectionString: "postgres://fixture", roleId: "manager", tenantId: "tenant", runId: "run",
    });

    expect(connector?.allowedTools).toEqual(enabledNames);
    expect(connector?.mcpServers.project).toMatchObject({ transport: "stdio", command: process.execPath });
    expect((connector?.mcpServers.project as { args?: readonly string[] } | undefined)?.args?.[0]).toContain("projectMcpServer.js");
    const gemini = createProjectGeminiTools({ connectionString: "postgres://fixture", tenantId: "tenant", roleId: "manager", runId: "run" }, connector?.allowedTools ?? []);
    expect(gemini.map((tool) => tool.name)).toEqual(enabledNames);
    expect([...connector?.allowedTools ?? [], ...gemini.map((tool) => tool.name)]).not.toEqual(expect.arrayContaining(disabledNames));
  });

  it("does not mount a project server or Gemini project tools for a member without project grants", async () => {
    const connector = await resolveGrantedProjectConnector({
      database: databaseFor([]), connectionString: "postgres://fixture", roleId: "member", tenantId: "tenant", runId: "run",
    });
    expect(connector).toBeUndefined();
    expect(createProjectGeminiTools({ connectionString: "postgres://fixture", tenantId: "tenant", roleId: "member", runId: "run" }, [])).toEqual([]);
  });
});
