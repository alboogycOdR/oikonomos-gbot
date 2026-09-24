import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { defaultPoolConfig, type AvatarColor, type AvatarShape, type NewRole, type Role, type RoleGrant } from "@oikonomos/db";

import { buildApp } from "./app.js";
import { buildSessionCookie, createSessionToken } from "./auth.js";
import { createDatabaseBackedDeps, type ControlApiDeps } from "./ports.js";

const token = "task-347-test-token";
const tenantA = "task-347-tenant-a";
const tenantB = "task-347-tenant-b";

function role(overrides: Partial<Role> = {}): Role {
  return {
    roleId: "task-347-role", tenantId: tenantA, name: "Avatar", title: "Avatar", description: "",
    instructions: null, provider: null, model: null, status: "active", avatarColor: null, avatarShape: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function depsForAvatarTests(): ControlApiDeps {
  let stored = role();
  return {
    createRole: async (input: NewRole) => { stored = role({ ...input }); return stored; },
    listCapabilities: async () => [], upsertRoleGrant: async (input: RoleGrant) => input,
    updateRoleAvatar: async (input: { roleId: string; tenantId: string; avatarColor?: AvatarColor; avatarShape?: AvatarShape }) => {
      if (input.tenantId !== stored.tenantId || input.roleId !== stored.roleId) return null;
      stored = role({ ...stored, avatarColor: input.avatarColor ?? stored.avatarColor, avatarShape: input.avatarShape ?? stored.avatarShape });
      return stored;
    },
  } as unknown as ControlApiDeps;
}

function headers(tenantId: string): { cookie: string } {
  return { cookie: buildSessionCookie(createSessionToken(token, tenantId)) };
}

describe("TASK-347 avatar routes", () => {
  it("creates, lists, and patches persisted avatar tokens", async () => {
    const app = buildApp(depsForAvatarTests(), { authToken: token, logger: false });
    const authHeaders = headers(tenantA);
    const created = await app.inject({ method: "POST", url: "/roles", headers: authHeaders, payload: { name: "Avatar", description: "", avatarColor: "violet", avatarShape: "hexagon" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ avatarColor: "violet", avatarShape: "hexagon" });
    const roleId = created.json<{ id: string }>().id;
    const patched = await app.inject({ method: "PATCH", url: `/roles/${roleId}`, headers: authHeaders, payload: { avatarColor: "teal" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ avatarColor: "teal", avatarShape: "hexagon" });
    const invalid = await app.inject({ method: "PATCH", url: `/roles/${roleId}`, headers: authHeaders, payload: { avatarColor: "not-a-colour" } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("does not permit a different tenant to patch an avatar", async () => {
    const app = buildApp(depsForAvatarTests(), { authToken: token, logger: false });
    const response = await app.inject({ method: "PATCH", url: "/roles/task-347-role", headers: headers(tenantB), payload: { avatarShape: "star" } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("TASK-347 avatar routes — real Postgres", () => {
  const tenantId = `task-347-${randomUUID()}`;
  let pool: Pool;

  it("persists selected tokens through roles and threads, rejecting another tenant", async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    const app = buildApp(createDatabaseBackedDeps({ connectionString: connectionString! }), { authToken: token, logger: false });
    try {
      const created = await app.inject({ method: "POST", url: "/roles", headers: headers(tenantId), payload: { name: "Real Avatar", description: "route fixture", avatarColor: "violet", avatarShape: "hexagon" } });
      expect(created.statusCode).toBe(201);
      const roleId = created.json<{ id: string }>().id;
      const patched = await app.inject({ method: "PATCH", url: `/roles/${roleId}`, headers: headers(tenantId), payload: { avatarColor: "teal" } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ avatarColor: "teal", avatarShape: "hexagon" });
      expect((await app.inject({ method: "GET", url: "/roles", headers: headers(tenantId) })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: roleId, avatarColor: "teal", avatarShape: "hexagon" })]));
      expect((await app.inject({ method: "POST", url: "/threads", headers: headers(tenantId), payload: { roleId } })).statusCode).toBe(201);
      expect((await app.inject({ method: "GET", url: "/threads", headers: headers(tenantId) })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ roleId, avatarColor: "teal", avatarShape: "hexagon" })]));
      expect((await app.inject({ method: "PATCH", url: `/roles/${roleId}`, headers: headers(`${tenantId}-other`), payload: { avatarShape: "star" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "PATCH", url: `/roles/${roleId}`, headers: headers(tenantId), payload: { avatarShape: "unknown" } })).statusCode).toBe(400);
    } finally {
      await app.close();
      await pool.query("DELETE FROM threads WHERE role_id IN (SELECT role_id FROM roles WHERE tenant_id = $1)", [tenantId]);
      await pool.query("DELETE FROM role_grants WHERE role_id IN (SELECT role_id FROM roles WHERE tenant_id = $1)", [tenantId]);
      await pool.query("DELETE FROM roles WHERE tenant_id = $1", [tenantId]);
      await pool.end();
    }
  });
});
