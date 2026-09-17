import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { createRole } from "./roles.js";
import {
  createBotTemplate,
  createRoleTemplateInstall,
  getRoleTemplateInstall,
  type DatabaseOptions,
} from "./index.js";
import { withPool } from "./database.js";

/**
 * TASK-293 / spec §6.1: real-Postgres round trip for the `baseline_manifest`
 * column (`infra/postgres/migrations/029_role_template_install_baseline`),
 * separate from `templates.ts`'s own in-source CRUD suite (TASK-276's
 * Owned_Paths precedent — see that file's own comment) since this task's
 * Owned_Paths names this file directly rather than widening the in-source
 * one. Covers only the storage layer: a non-null baseline persists and
 * reads back byte-identical, and a null baseline (the legacy/pre-293 shape)
 * round-trips as null too. The route-level behaviour that *produces* and
 * *consumes* the baseline (install writing it, template-status comparing
 * against it, falling back to the template manifest when null) is covered
 * by `services/control-api/src/templates.test.ts`'s real-Postgres suite.
 */
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const dbOptions: DatabaseOptions = { connectionString: connectionString ?? "" };

integration("@oikonomos/db templates — baseline_manifest round trip (TASK-293)", () => {
  const tenantId = "task-293-baseline-manifest";
  const roleIds: string[] = [];

  async function cleanup(): Promise<void> {
    if (roleIds.length > 0) {
      await withPool(dbOptions, (pool) =>
        pool.query(`DELETE FROM role_template_installs WHERE role_id = ANY($1::text[])`, [roleIds]),
      );
    }
    await withPool(dbOptions, (pool) => pool.query(`DELETE FROM bot_templates WHERE tenant_id = $1`, [tenantId]));
  }

  afterAll(cleanup);

  it("persists and reads back a non-null baseline manifest byte-identical", async () => {
    const role = await createRole(dbOptions, {
      roleId: `task-293-baseline-${randomUUID()}`,
      tenantId,
      name: "Baseline Role",
      title: "Baseline Role",
      description: "",
    });
    roleIds.push(role.roleId);
    const template = await createBotTemplate(dbOptions, {
      tenantId,
      name: "Baseline Source",
      manifest: { identity: { name: "baseline-source" } },
      digest: "digest-293-baseline",
      createdBy: "human:1",
    });

    const baselineManifest = {
      identity: { name: "overridden-name" },
      skills: [],
      routines: [],
      integrations: [],
      memories: [],
    };
    const created = await createRoleTemplateInstall(dbOptions, {
      roleId: role.roleId,
      templateId: template.templateId,
      version: template.version,
      digest: template.digest,
      baselineManifest,
    });
    expect(created.baselineManifest).toEqual(baselineManifest);

    const fetched = await getRoleTemplateInstall(dbOptions, role.roleId);
    expect(fetched).toEqual(created);
    expect(fetched?.baselineManifest).toEqual(baselineManifest);
  });

  it("round-trips a null baseline manifest for a legacy-style install (baselineManifest omitted)", async () => {
    const role = await createRole(dbOptions, {
      roleId: `task-293-legacy-${randomUUID()}`,
      tenantId,
      name: "Legacy Role",
      title: "Legacy Role",
      description: "",
    });
    roleIds.push(role.roleId);
    const template = await createBotTemplate(dbOptions, {
      tenantId,
      name: "Legacy Source",
      manifest: { identity: { name: "legacy-source" } },
      digest: "digest-293-legacy",
      createdBy: "human:1",
    });

    const created = await createRoleTemplateInstall(dbOptions, {
      roleId: role.roleId,
      templateId: template.templateId,
      version: template.version,
      digest: template.digest,
    });
    expect(created.baselineManifest).toBeNull();

    const fetched = await getRoleTemplateInstall(dbOptions, role.roleId);
    expect(fetched?.baselineManifest).toBeNull();
  });
});
