import Fastify from "fastify";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  createRole,
  createRoutine,
  createSkill,
  Database,
  listBotTemplates,
  listEnabledForRole,
  listRoutines,
  setEnabledForRole,
  updateRoleInstructions,
  type BotTemplate,
  type Role,
} from "@oikonomos/db";
import { readProfileTier, writeMemoryFact } from "@oikonomos/memory";

import { DEFAULT_ROLE_CAPABILITIES } from "./defaultCapabilities.js";
import { registerTemplateRoutes } from "./templates.js";
import type { ControlApiDeps as ApiDeps } from "./ports.js";
import { buildApp } from "./app.js";
import { createDatabaseBackedDeps } from "./ports.js";

const TENANT = "template-route-test";
const ROLE_ID = "role-template-source";

function role(overrides: Partial<Role> = {}): Role {
  return {
    roleId: ROLE_ID, tenantId: TENANT, name: "source-bot", title: "Source Bot",
    description: "Ordinary description.", instructions: "Ordinary instructions.", provider: null, model: null,
    status: "active", createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function template(manifest: Record<string, unknown>): BotTemplate {
  return {
    templateId: "11111111-1111-1111-1111-111111111111", version: 1, tenantId: TENANT,
    name: "Source template", manifest, digest: "a".repeat(64), visibility: "private", createdBy: "tenant:test", createdAt: new Date(),
  };
}

function routeFixture(source: Role = role()) {
  const templates: BotTemplate[] = [];
  const audits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const grants: string[] = [];
  const installs: string[] = [];
  const deps: Partial<ApiDeps> = {
    listRoles: async () => [source],
    listEnabledSkillsForRole: async () => [],
    listRoutines: async () => [],
    listCapabilities: async () => [
      { capabilityId: "fs.read", description: "read", defaultTier: "T0_observe", adapter: "sdk:builtin", enabled: true },
      { capabilityId: "mail.send", description: "mail", defaultTier: "T2_internal", adapter: "mcp", enabled: true },
    ],
    createBotTemplate: async (input) => {
      const created = template(input.manifest);
      templates.push(created);
      return created;
    },
    listBotTemplates: async () => templates,
    getLatestBotTemplate: async () => templates[0] ?? null,
    getBotTemplate: async (_templateId, version) => templates.find((candidate) => candidate.version === version) ?? null,
    insertAuditEvent: async (input) => { audits.push({ eventType: input.eventType, payload: input.payload }); },
    createRole: async (input) => role({ roleId: input.roleId, name: input.name, title: input.title, description: input.description }),
    upsertRoleGrant: async (input) => { grants.push(input.capabilityId); return input; },
    createRoleTemplateInstall: async (input) => { installs.push(input.roleId); },
  };
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => { request.tenantId = TENANT; });
  registerTemplateRoutes(app, deps as ApiDeps);
  return { app, templates, audits, grants, installs };
}

describe("template route composition", () => {
  const auditKey = ["sk", "PLACEHOLDER_FAKE_NOT_A_REAL_SECRET_KEY_0000"].join("-");
  const jwt = [
    Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "test" })).toString("base64url"),
    "PLACEHOLDER_SIGNATURE",
  ].join(".");
  const fixtures: Array<[string, string, string]> = [
    ["audit_pattern_family", `Key ${auditKey}`, "audit_pattern_family"],
    ["jwt_shape", `Token ${jwt}`, "jwt_shape"],
    ["credential_url", "https://user:PLACEHOLDER@example.test/path", "credential_url"],
    ["high_entropy_blob", "aZ3kQ9mN2xP7vR4tW8yU1bC6dF0gH5jL9nQ2sV7wX4z", "high_entropy_blob"],
    ["secret_ref", "secret://vault/placeholder", "secret_ref"],
  ];

  it.each(fixtures)("refuses export for %s through the composed production route", async (_label, instructions, expectedClass) => {
    const { app, templates, audits } = routeFixture(role({ instructions }));
    const result = await app.inject({ method: "POST", url: `/roles/${ROLE_ID}/templates`, payload: { name: "Test template" } });
    expect(result.statusCode).toBe(422);
    expect(JSON.parse(result.body).classes).toContain(expectedClass);
    expect(templates).toHaveLength(0);
    expect(audits).toEqual([{ eventType: "template.export_refused", payload: expect.objectContaining({ classes: expect.arrayContaining([expectedClass]) }) }]);
    await app.close();
  });

  it("installs with only the automatic floor and records immutable provenance", async () => {
    const { app, templates, grants, installs, audits } = routeFixture();
    const exported = await app.inject({ method: "POST", url: `/roles/${ROLE_ID}/templates`, payload: { name: "Source template" } });
    expect(exported.statusCode).toBe(201);
    (templates[0]!.manifest as { integrations: unknown[] }).integrations = [{ capability_id: "mail.send", requested_max_tier: "T2_internal" }];
    const installed = await app.inject({ method: "POST", url: `/templates/${templates[0]!.templateId}/install`, payload: {} });
    expect(installed.statusCode).toBe(201);
    expect(grants).toEqual(["fs.read"]);
    expect(installs).toHaveLength(1);
    expect(JSON.parse(installed.body).grant_checklist).toEqual([{ capability_id: "mail.send", requested_max_tier: "T2_internal", status: "available" }]);
    expect(audits.map((event) => event.eventType)).toEqual(["template.exported", "template.installed"]);
    await app.close();
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("template export/install — production composition against real Postgres", () => {
  it("round-trips a persisted export into an independently created role", async () => {
    const sourceId = `task-278-source-${crypto.randomUUID()}`;
    const tenantId = "basileia";
    const skillName = `template-skill-${crypto.randomUUID().slice(0, 8)}`;
    const routineName = `template-routine-${crypto.randomUUID().slice(0, 8)}`;
    const integrationId = `template.integration.${crypto.randomUUID().slice(0, 8)}`;
    await createRole({ connectionString: connectionString! }, {
      roleId: sourceId, tenantId, name: `source-${Date.now()}`, title: "Source", description: "Round-trip source.",
    });
    await updateRoleInstructions({ connectionString: connectionString! }, sourceId, "Production route proof.");
    const sourceSkill = await createSkill({ connectionString: connectionString! }, {
      tenantId, name: skillName, description: "Round-trip skill", whenToUse: "When testing templates.", body: "Perform the round-trip check.",
    });
    await setEnabledForRole({ connectionString: connectionString! }, sourceId, sourceSkill.skillId, true);
    await createRoutine({ connectionString: connectionString! }, {
      tenantId, roleId: sourceId, name: routineName, schedule: "0 9 * * *", definition: { goal: "Check template parity" }, skillId: sourceSkill.skillId,
    });
    await writeMemoryFact({ connectionString: connectionString! }, {
      tenantId, roleId: sourceId, scope: "agent", tier: "profile", key: "preferred-style", value: "concise", source: "template-test",
    });
    const sourceDatabase = new Database({ connectionString: connectionString! });
    await sourceDatabase.upsertCapability({ capabilityId: integrationId, description: "Template integration fixture", defaultTier: "T2_internal", adapter: "test", enabled: true });
    await sourceDatabase.upsertRoleGrant({ roleId: sourceId, capabilityId: integrationId, maxTier: "T2_internal", constraints: {} });
    await sourceDatabase.close();
    const app = buildApp(createDatabaseBackedDeps({ connectionString: connectionString! }), { authToken: "task-278-token", logger: false });
    const headers = { authorization: "Bearer task-278-token" };
    const exported = await app.inject({ method: "POST", url: `/roles/${sourceId}/templates`, headers, payload: { name: "Round trip", include_memories: ["preferred-style"] } });
    expect(exported.statusCode).toBe(201);
    const exportedBody = JSON.parse(exported.body) as { templateId: string; version: number; digest: string };
    const persisted = await listBotTemplates({ connectionString: connectionString! }, { tenantId, templateId: exportedBody.templateId });
    expect(persisted).toHaveLength(1);
    const installed = await app.inject({ method: "POST", url: `/templates/${exportedBody.templateId}/install`, headers, payload: { version: exportedBody.version, include_memories: ["preferred-style"] } });
    expect(installed.statusCode).toBe(201);
    const installedRoleId = JSON.parse(installed.body).role.roleId as string;
    expect(installedRoleId).not.toBe(sourceId);
    const database = new Database({ connectionString: connectionString! });
    const expectedFloor = (await database.listCapabilities())
      .filter((capability) => (DEFAULT_ROLE_CAPABILITIES as readonly string[]).includes(capability.capabilityId))
      .map((capability) => capability.capabilityId)
      .sort();
    expect((await database.listRoleGrants(installedRoleId)).map((grant) => grant.capabilityId).sort())
      .toEqual(expectedFloor);
    expect((await listEnabledForRole({ connectionString: connectionString! }, installedRoleId)).map((skill) => skill.name))
      .toEqual([skillName]);
    const installedRoutines = await listRoutines({ connectionString: connectionString! }, { tenantId, roleId: installedRoleId });
    expect(installedRoutines).toEqual([expect.objectContaining({ name: routineName, paused: true, skillId: sourceSkill.skillId })]);
    expect(await readProfileTier({ connectionString: connectionString! }, { tenantId, roleId: installedRoleId }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ key: "preferred-style", value: "concise", scope: "agent", tier: "profile" })]));
    expect(JSON.parse(installed.body).grant_checklist).toEqual(expect.arrayContaining([
      { capability_id: integrationId, requested_max_tier: "T2_internal", status: "available" },
    ]));
    expect((await database.listRoleGrants(installedRoleId)).map((grant) => grant.capabilityId)).not.toContain(integrationId);
    await database.close();
    await app.close();
  });

  it("runs the refusal scan and audit write through buildApp's DB-backed composition", async () => {
    const sourceId = `task-278-secret-${crypto.randomUUID()}`;
    const tenantId = "basileia";
    const credentialShapedInstructions = ["sk", "PLACEHOLDER_FAKE_NOT_A_REAL_SECRET_KEY_0000"].join("-");
    await createRole({ connectionString: connectionString! }, {
      roleId: sourceId, tenantId, name: `secret-source-${Date.now()}`, title: "Secret Source", description: "Route liveness source.",
    });
    await updateRoleInstructions({ connectionString: connectionString! }, sourceId, credentialShapedInstructions);
    const before = await listBotTemplates({ connectionString: connectionString! }, { tenantId });
    const app = buildApp(createDatabaseBackedDeps({ connectionString: connectionString! }), { authToken: "task-278-token", logger: false });
    const response = await app.inject({
      method: "POST",
      url: `/roles/${sourceId}/templates`,
      headers: { authorization: "Bearer task-278-token" },
      payload: { name: "Must not persist" },
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).classes).toContain("audit_pattern_family");
    expect(await listBotTemplates({ connectionString: connectionString! }, { tenantId })).toHaveLength(before.length);

    const pool = new Pool({ connectionString: connectionString!, allowExitOnIdle: true });
    try {
      const auditRows = await pool.query<{ event_type: string; payload: { role_id?: string } }>(
        `SELECT event_type, payload FROM audit_events
         WHERE event_type = 'template.export_refused' AND payload->>'role_id' = $1`,
        [sourceId],
      );
      expect(auditRows.rows).toHaveLength(1);
      expect(auditRows.rows[0]?.event_type).toBe("template.export_refused");
    } finally {
      await pool.end();
      await app.close();
    }
  });
});
