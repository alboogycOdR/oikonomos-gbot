import { describe, expect, it } from "vitest";

import {
  combineConnectorContexts,
  isBrowserLaneGranted,
  resolveGrantedBrowserConnector,
  WORKSPACE_REQUEST_SECRET_CAPABILITY_ID,
  WORKSPACE_REQUEST_SECRET_TOOL,
} from "./connectorResolution.js";
import type { ConnectorContext } from "./executeRun.js";
import { defaultManifestsDir, loadManifests, type ConnectorManifest } from "@oikonomos/connectors";
import type { Database } from "@oikonomos/db";

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

describe("browser lane grant resolution (TASK-204)", () => {
  // TASK-207 Blocking-1 (Fable review of d44e64a): keep this in exact sync
  // with packages/connectors/manifests/steel-browser.yaml's own declared
  // tools — see chatRunDriver.test.ts's own steelBrowserManifest for the
  // full explanation of why drift here breaks unrelated tests.
  const steelManifest: ConnectorManifest = {
    connector_id: "steel-browser",
    account_ownership: "basileia",
    mcp_server: { name: "steel", transport: "remote", url_ref: "secret://mcp/steel-browser/url" },
    tools: [
      { tool_name: "mcp__steel__steel_session_create", capability_id: "browser.session", default_tier: "T1_draft" },
      { tool_name: "mcp__steel__steel_session_release", capability_id: "browser.session", default_tier: "T1_draft" },
      { tool_name: "mcp__steel__steel_navigate", capability_id: "browser.navigate", default_tier: "T1_draft" },
      { tool_name: "mcp__steel__steel_snapshot", capability_id: "browser.read", default_tier: "T0_observe" },
      { tool_name: "mcp__steel__steel_act", capability_id: "browser.interact", default_tier: "T2_internal" },
      { tool_name: "mcp__steel__steel_screenshot", capability_id: "browser.screenshot", default_tier: "T0_observe", enabled: false },
    ],
    role_grants: [],
    evals: { suite: "evals/golden/suites/steel-browser", min_pass_rate: 0.9 },
    review: { onboarded_by: "test", date: "2026-09-07", scope_justification: "TASK-204 fixture" },
  };

  function fakeDatabase(grantedCapabilityIds: readonly string[]): Database {
    return {
      listRoleGrants: async () => grantedCapabilityIds.map((capabilityId) => ({
        roleId: "browser-role", capabilityId, maxTier: "T2_internal", constraints: {},
      })),
    } as unknown as Database;
  }

  // TASK-207 re-review (Fable 5.1): a comment is not a structural guard —
  // make drift a build failure instead. `enabled: false` on screenshot here
  // is a deliberate per-test override (see the AC below), not drift, so
  // compare name/capability_id/tier only, not the raw tools array.
  it("keeps steelManifest's tool_name/capability_id/default_tier in exact sync with the real steel-browser.yaml manifest", async () => {
    const realManifest = (await loadManifests(defaultManifestsDir())).find((manifest) => manifest.connector_id === "steel-browser");
    const strip = (tools: ConnectorManifest["tools"]) =>
      tools.map(({ tool_name, capability_id, default_tier }) => ({ tool_name, capability_id, default_tier }));
    expect(strip(steelManifest.tools)).toEqual(strip(realManifest?.tools ?? []));
  });

  it("mounts no browser tools for a role with zero granted browser.* capabilities", async () => {
    const connector = await resolveGrantedBrowserConnector({
      database: fakeDatabase([]),
      manifests: [steelManifest],
      roleId: "browser-role",
    });
    expect(connector).toBeUndefined();
    expect(isBrowserLaneGranted([steelManifest], new Set())).toBe(false);
  });

  it("mounts no browser tools when the steel-browser manifest is not loaded", async () => {
    const connector = await resolveGrantedBrowserConnector({
      database: fakeDatabase(["browser.navigate"]),
      manifests: [],
      roleId: "browser-role",
    });
    expect(connector).toBeUndefined();
    expect(isBrowserLaneGranted([], new Set(["browser.navigate"]))).toBe(false);
  });

  it("derives only the granted, enabled steel tools as a local stdio MCP mount — no pool/handle (TASK-186's open design question)", async () => {
    const connector = await resolveGrantedBrowserConnector({
      database: fakeDatabase(["browser.navigate", "browser.read", "browser.screenshot"]),
      manifests: [steelManifest],
      roleId: "browser-role",
    });
    // browser.screenshot is granted but its tool is enabled:false — must stay absent.
    expect(connector).toMatchObject({
      allowedTools: ["mcp__steel__steel_navigate", "mcp__steel__steel_snapshot"],
      mcpServers: { steel: { transport: "stdio", command: "node", args: ["/opt/oikonomos/steel-mcp/dist/stdio.js"] } },
    });
    expect(connector?.manifest.connector_id).toBe("steel-browser");
    expect(isBrowserLaneGranted([steelManifest], new Set(["browser.navigate"]))).toBe(true);
  });

  it("combines the browser connector with the other four into one mounted surface (TASK-139 precedent)", () => {
    const context = (id: string): ConnectorContext => ({
      manifest: { connector_id: id, mcp_server: { name: id }, tools: [] },
      mcpServers: { [id]: { transport: "stdio", command: "node" } },
      allowedTools: [`mcp__${id}__list`],
    });
    const combined = combineConnectorContexts(context("gmail"), context("steel-browser"));
    expect(combined).toMatchObject({
      connectorIds: ["gmail", "steel-browser"],
      allowedTools: ["mcp__gmail__list", "mcp__steel-browser__list"],
    });
  });
});
