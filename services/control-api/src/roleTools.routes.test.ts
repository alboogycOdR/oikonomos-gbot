import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPoolConfig } from "@oikonomos/db";

import { buildApp } from "./app.js";
import { buildSessionCookie, createSessionToken } from "./auth.js";
import { createDatabaseBackedDeps } from "./ports.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("TASK-351 role tools route", () => {
  const tenantId = `task-351-${randomUUID()}`;
  const otherTenantId = `task-351-other-${randomUUID()}`;
  const roleId = randomUUID();
  const otherRoleId = randomUUID();
  const catalogPrefix = `task-351-${randomUUID()}`;
  const gmailCapabilityId = `${catalogPrefix}.gmail.read`;
  const browserCapabilityId = `${catalogPrefix}.browser.interact`;
  const shellCapabilityId = `${catalogPrefix}.shell.exec`;
  const authToken = "task-351-route-token";
  const auth = { cookie: buildSessionCookie(createSessionToken(authToken, tenantId)) };
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;

  function tool(catalog: unknown, capabilityId: string): Record<string, unknown> | undefined {
    const systems = (catalog as { systems: Array<{ tools: Array<Record<string, unknown>> }> }).systems;
    return systems.flatMap((system) => system.tools).find((candidate) => candidate.id === capabilityId);
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM role_grants WHERE role_id = ANY($1::text[])", [[roleId, otherRoleId]]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [[roleId, otherRoleId]]);
    await pool.query("DELETE FROM capabilities WHERE capability_id = ANY($1::text[])", [[gmailCapabilityId, browserCapabilityId, shellCapabilityId]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await pool.query(
      `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled) VALUES
       ($1, 'Read messages from the connected Gmail mailbox.', 'T1_draft', 'mcp:gmail', true),
       ($2, 'Interact with a browser page.', 'T2_internal', 'mcp:steel-browser', true),
       ($3, 'Execute a shell command.', 'T3_external', 'sdk:builtin', true)`,
      [gmailCapabilityId, browserCapabilityId, shellCapabilityId],
    );
    await pool.query(
      `INSERT INTO roles (role_id, tenant_id, name, title, description) VALUES
       ($1, $2, 'Tools fixture', 'Tools fixture', 'TASK-351 catalog fixture'),
       ($3, $4, 'Other fixture', 'Other fixture', 'TASK-351 tenant isolation fixture')`,
      [roleId, tenantId, otherRoleId, otherTenantId],
    );
    app = buildApp(createDatabaseBackedDeps({ connectionString: connectionString! }), { authToken, logger: false });
  });

  afterAll(async () => {
    try {
      await app.close();
    } finally {
      await cleanup();
      await pool.end();
    }
  });

  it("groups the catalog, projects grant state, and reflects grant/revoke lifecycle", async () => {
    const before = await app.inject({ method: "GET", url: `/roles/${roleId}/tools`, headers: auth });
    expect(before.statusCode).toBe(200);
    const beforeCatalog = before.json();
    expect(beforeCatalog).toMatchObject({ systems: expect.any(Array) });
    expect(tool(beforeCatalog, gmailCapabilityId)).toMatchObject({ label: expect.any(String), granted: false, maxTier: null, grantable: true });
    expect(tool(beforeCatalog, browserCapabilityId)).toMatchObject({ granted: false, maxTier: null, grantable: true });
    expect(tool(beforeCatalog, shellCapabilityId)).toMatchObject({ granted: false, maxTier: null, grantable: false });
    // LIVENESS for the named ADR-018 exception: removing the denylist makes
    // this registered T2 action appear self-grantable.
    expect(tool(beforeCatalog, "browser.interact")).toMatchObject({ grantable: false });
    expect(JSON.stringify(before.json())).not.toContain("secret://");
    expect(JSON.stringify(before.json())).not.toContain("constraints");

    expect((await app.inject({
      method: "POST", url: `/roles/${roleId}/grants`, headers: auth,
      payload: { capabilityId: gmailCapabilityId, maxTier: "T1_draft" },
    })).statusCode).toBe(201);
    expect(tool((await app.inject({ method: "GET", url: `/roles/${roleId}/tools`, headers: auth })).json(), gmailCapabilityId))
      .toMatchObject({ granted: true, maxTier: "T1_draft" });

    expect((await app.inject({ method: "DELETE", url: `/roles/${roleId}/grants/${gmailCapabilityId}`, headers: auth })).statusCode).toBe(204);
    expect(tool((await app.inject({ method: "GET", url: `/roles/${roleId}/tools`, headers: auth })).json(), gmailCapabilityId))
      .toMatchObject({ granted: false, maxTier: null });
  });

  it("refuses a catalog request for a role in another tenant", async () => {
    const response = await app.inject({ method: "GET", url: `/roles/${otherRoleId}/tools`, headers: auth });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "role not found" });
  });

  it("reports only safe operator connector configuration states", async () => {
    const previousShared = process.env.OIK_CONNECTOR_STATUS_ENVIRONMENT;
    const previousGmailUrl = process.env.OIK_SECRET_MCP_GMAIL_URL;
    const secretValue = "task-361-secret-value";
    const secretRef = "secret://mcp/gmail/url";
    let logs = "";
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      },
    });
    const loggingApp = buildApp(createDatabaseBackedDeps({ connectionString: connectionString! }), { authToken, logStream });

    try {
      process.env.OIK_CONNECTOR_STATUS_ENVIRONMENT = "shared";
      process.env.OIK_SECRET_MCP_GMAIL_URL = secretValue;
      expect(tool((await app.inject({ method: "GET", url: `/roles/${roleId}/tools`, headers: auth })).json(), gmailCapabilityId)).toBeDefined();
      const configured = await app.inject({ method: "GET", url: `/roles/${roleId}/tools`, headers: auth });
      expect(configured.json().systems.find((system: { id: string }) => system.id === "gmail")).toMatchObject({ configured: true });

      delete process.env.OIK_SECRET_MCP_GMAIL_URL;
      const unset = await app.inject({ method: "GET", url: `/roles/${roleId}/tools`, headers: auth });
      expect(unset.json().systems.find((system: { id: string }) => system.id === "gmail")).toMatchObject({ configured: false });

      process.env.OIK_SECRET_MCP_GMAIL_URL = "";
      const empty = await app.inject({ method: "GET", url: `/roles/${roleId}/tools`, headers: auth });
      expect(empty.json().systems.find((system: { id: string }) => system.id === "gmail")).toMatchObject({ configured: false });

      process.env.OIK_CONNECTOR_STATUS_ENVIRONMENT = "isolated";
      const unknown = await loggingApp.inject({ method: "GET", url: `/roles/${roleId}/tools`, headers: auth });
      const body = unknown.body;
      expect(unknown.json().systems.find((system: { id: string }) => system.id === "gmail")).toMatchObject({ configured: "unknown" });
      expect(unknown.json().systems.find((system: { id: string }) => system.id === "builtin")).not.toHaveProperty("configured");
      expect(body).not.toContain(secretValue);
      expect(body).not.toContain(secretRef);
      expect(logs).not.toContain(secretValue);
      expect(logs).not.toContain(secretRef);
    } finally {
      await loggingApp.close();
      if (previousShared === undefined) delete process.env.OIK_CONNECTOR_STATUS_ENVIRONMENT;
      else process.env.OIK_CONNECTOR_STATUS_ENVIRONMENT = previousShared;
      if (previousGmailUrl === undefined) delete process.env.OIK_SECRET_MCP_GMAIL_URL;
      else process.env.OIK_SECRET_MCP_GMAIL_URL = previousGmailUrl;
    }
  });
});
