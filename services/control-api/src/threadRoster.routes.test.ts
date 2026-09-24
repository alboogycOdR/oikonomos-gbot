import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRole, createThread, defaultPoolConfig, insertMessage } from "@oikonomos/db";

import { buildApp } from "./app.js";
import { getOpenApiDocument } from "./openapi.js";
import { createDatabaseBackedDeps } from "./ports.js";

const TOKEN = "task-331-roster-token";
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const tenantId = "basileia";
const otherTenantId = "task-331-other-tenant";
const ownRoleId = `task-331-own-${randomUUID()}`;
const storedTitleRoleId = `task-331-stored-${randomUUID()}`;
const otherRoleId = `task-331-other-${randomUUID()}`;

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

integration("GET /threads roster (TASK-331)", () => {
  let pool: Pool;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = ANY($1))", [[ownRoleId, storedTitleRoleId, otherRoleId]]);
    await pool.query("DELETE FROM thread_members WHERE role_id = ANY($1)", [[ownRoleId, storedTitleRoleId, otherRoleId]]);
    await pool.query("DELETE FROM threads WHERE role_id = ANY($1)", [[ownRoleId, storedTitleRoleId, otherRoleId]]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1)", [[ownRoleId, storedTitleRoleId, otherRoleId]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole({ connectionString: connectionString! }, { roleId: ownRoleId, tenantId, name: "Roster Owner", title: "Roster Owner" });
    await createRole({ connectionString: connectionString! }, { roleId: storedTitleRoleId, tenantId, name: "Stored Title", title: "Stored Title" });
    await createRole({ connectionString: connectionString! }, { roleId: otherRoleId, tenantId: otherTenantId, name: "Other Tenant", title: "Other Tenant" });
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("returns derived fields for its tenant only, without per-thread message reads", async () => {
    const ownThread = await createThread({ connectionString: connectionString! }, { roleId: ownRoleId });
    const emptyStoredTitleThread = await createThread({ connectionString: connectionString! }, { roleId: storedTitleRoleId, title: "Stored title wins" });
    const otherThread = await createThread({ connectionString: connectionString! }, { roleId: otherRoleId, title: "Must not leak" });
    await insertMessage(
      { connectionString: connectionString! },
      { threadId: ownThread.id, role: "user", body: "  A concise title comes from this first user message  " },
    );
    const latest = await insertMessage(
      { connectionString: connectionString! },
      { threadId: ownThread.id, role: "bot", body: "  Latest\n response\twith collapsed whitespace  " },
    );

    const app = buildApp(createDatabaseBackedDeps({ connectionString: connectionString! }), { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/threads", headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      const threads = response.json() as Array<{
        id: string;
        title: string | null;
        preview: { text: string; authorKind: string } | null;
        lastMessageAt: string | null;
      }>;
      expect(threads).toContainEqual(expect.objectContaining({
        id: ownThread.id,
        title: "A concise title comes from this",
        preview: { text: "Latest response with collapsed whitespace", authorKind: "bot" },
        lastMessageAt: latest.createdAt.toISOString(),
      }));
      expect(threads).toContainEqual(expect.objectContaining({
        id: emptyStoredTitleThread.id,
        title: "Stored title wins",
        preview: null,
        lastMessageAt: null,
      }));
      expect(threads.some((thread) => thread.id === otherThread.id)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("GET /threads roster OpenAPI (TASK-331)", () => {
  it("documents title, preview with author kind, and lastMessageAt", () => {
    const document = getOpenApiDocument() as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const threadsPath = document.paths["/threads"] as {
      get?: { responses?: Record<string, { content?: Record<string, { schema?: { items?: { $ref?: string } } }> }> };
    };
    expect(threadsPath.get?.responses?.["200"]?.content?.["application/json"]?.schema?.items?.$ref)
      .toBe("#/components/schemas/ThreadRoster");
    expect(document.components.schemas.ThreadRoster?.properties).toEqual(expect.objectContaining({
      title: expect.any(Object),
      preview: expect.any(Object),
      lastMessageAt: expect.any(Object),
    }));
  });
});
