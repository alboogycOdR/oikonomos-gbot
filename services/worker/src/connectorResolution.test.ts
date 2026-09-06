import { describe, expect, it } from "vitest";

import {
  combineConnectorContexts,
  WORKSPACE_REQUEST_SECRET_CAPABILITY_ID,
  WORKSPACE_REQUEST_SECRET_TOOL,
} from "./connectorResolution.js";
import type { ConnectorContext } from "./executeRun.js";

// TASK-175 carve: this file's own source plus chatRunDriver.ts's are both
// read for the "derives Gmail's mounted surface" liveness assertion below —
// the per-run grant filter now lives here in connectorResolution.ts, while
// the mountedToolNames/`connector?.allowedTools` consumer and the Gmail
// minter wiring stay in chatRunDriver.ts's `createChatRunDriver`. Splitting
// the string checks across the two real files (rather than only one)
// preserves exactly what TASK-128's original single-file assertion proved.
const connectorResolutionSource = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("./connectorResolution.ts", import.meta.url), "utf8"),
);
const chatRunDriverSource = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("./chatRunDriver.ts", import.meta.url), "utf8"),
);

describe("connector resolution", () => {
  it("declares request_secret as a grant-gated workspace MCP surface", () => {
    expect(WORKSPACE_REQUEST_SECRET_CAPABILITY_ID).toBe("workspace.request_secret");
    expect(WORKSPACE_REQUEST_SECRET_TOOL).toBe("mcp__workspace__request_secret");
    expect(connectorResolutionSource).toContain("grantedCapabilities.has(WORKSPACE_REQUEST_SECRET_CAPABILITY_ID)");
  });
  it("merges zero, one, two, and four connector contexts without pairwise limits (TASK-139)", () => {
    const context = (id: string): ConnectorContext => ({
      manifest: { connector_id: id, mcp_server: { name: id }, tools: [] },
      mcpServers: { [id]: { transport: "http", url: `http://${id}.fixture.invalid/mcp` } },
      allowedTools: [`mcp__${id}__list`],
    });
    const [gmail, workspace, calendar, drive] = ["gmail", "workspace", "google-calendar", "google-drive"].map(context);
    expect(combineConnectorContexts()).toBeUndefined();
    expect(combineConnectorContexts(gmail)).toMatchObject({ allowedTools: ["mcp__gmail__list"], mcpServers: { gmail: expect.anything() } });
    expect(combineConnectorContexts(gmail, workspace)).toMatchObject({ allowedTools: ["mcp__gmail__list", "mcp__workspace__list"] });
    expect(combineConnectorContexts(gmail, workspace, calendar, drive)).toMatchObject({
      connectorIds: ["gmail", "workspace", "google-calendar", "google-drive"],
      allowedTools: ["mcp__gmail__list", "mcp__workspace__list", "mcp__google-calendar__list", "mcp__google-drive__list"],
      mcpServers: { gmail: expect.anything(), workspace: expect.anything(), "google-calendar": expect.anything(), "google-drive": expect.anything() },
    });
  });

  it("derives Gmail's mounted surface from persisted, enabled grants only (TASK-128)", () => {
    // This is deliberately tied to the per-run filter rather than merely the
    // broker's later tier check: deleting it would mount every Gmail manifest
    // tool (including ungranted email.send) and makes this test red.
    expect(connectorResolutionSource).toContain("database.listRoleGrants(input.roleId)");
    expect(connectorResolutionSource).toContain("tool.enabled !== false && grantedCapabilities.has(tool.capability_id)");
    expect(connectorResolutionSource).toContain("connector: { manifest, mcpServers: handle.mcpServers, allowedTools }");
    expect(chatRunDriverSource).toContain("mint: createGmailConnectorSessionMinter");
    expect(chatRunDriverSource).toContain("connector?.allowedTools");
  });
});
