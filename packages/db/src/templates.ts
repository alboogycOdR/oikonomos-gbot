import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";

/**
 * TASK-276 / ADR-018 "Storage" section (specs/OIKONOMOS_TEMPLATES_v1.0.md
 * §4). Foundation storage only — no export/install route, no credential
 * scan, no `packages/templates` projection (all TASK-278 and later). This
 * module is a typed CRUD layer over `bot_templates` exactly as migrated in
 * `infra/postgres/migrations/026_bot_templates.up.sql`, mirroring
 * roles.ts's shape (createRole/getRole/listRoles) per this task's own
 * Acceptance_Criteria.
 *
 * `visibility` is CHECK-constrained to `'private'` at the schema level
 * (spec §4.2 — widened by a later ADR when team/public distribution is
 * decided). This module does not invent a wider vocabulary ahead of that.
 */
export const templateVisibilities = ["private"] as const;
export type TemplateVisibility = (typeof templateVisibilities)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function requireUuid(value: string, field: string): string {
  const trimmed = requireNonEmpty(value, field);
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`${field} must be a UUID.`);
  }
  return trimmed;
}

function requireOptionalUuid(value: string | undefined, field: string): string | null {
  if (value === undefined) {
    return null;
  }
  return requireUuid(value, field);
}

function requireTemplateVisibility(value: TemplateVisibility, field: string): TemplateVisibility {
  if (!templateVisibilities.includes(value)) {
    throw new Error(`${field} must be one of: ${templateVisibilities.join(", ")}.`);
  }
  return value;
}

/**
 * A new template version. Omit `templateId` to export a brand-new template
 * (version 1); pass an existing `templateId` to record a new version of it
 * — the version number is computed server-side as
 * `MAX(version WHERE template_id = ...) + 1`, so this module never has to
 * be trusted to compute it correctly across a race (spec §4.1: rows are
 * immutable, a new export of the same template id is `version + 1`).
 */
export interface NewBotTemplate {
  templateId?: string;
  tenantId: string;
  name: string;
  /** The projected, already-scanned manifest (ADR-018 §1/§2) — this layer stores it, never validates or scans it. */
  manifest: Record<string, unknown>;
  digest: string;
  visibility?: TemplateVisibility;
  createdBy: string;
}

export interface BotTemplate {
  templateId: string;
  version: number;
  tenantId: string;
  name: string;
  manifest: Record<string, unknown>;
  digest: string;
  visibility: TemplateVisibility;
  createdBy: string;
  createdAt: Date;
}

export interface BotTemplateListFilter {
  tenantId: string;
  templateId?: string;
}

interface BotTemplateRow extends QueryResultRow {
  template_id: string;
  version: number;
  tenant_id: string;
  name: string;
  manifest: Record<string, unknown>;
  digest: string;
  visibility: TemplateVisibility;
  created_by: string;
  created_at: Date;
}

const botTemplateColumns = `template_id, version, tenant_id, name, manifest, digest, visibility, created_by, created_at`;

function toBotTemplate(row: BotTemplateRow): BotTemplate {
  return {
    templateId: row.template_id,
    version: row.version,
    tenantId: row.tenant_id,
    name: row.name,
    manifest: row.manifest,
    digest: row.digest,
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Insert a new, immutable `bot_templates` row. If `templateId` names an
 * existing template, this creates the next version of it; otherwise (or if
 * omitted) it starts a new template lineage at version 1. Computed and
 * inserted in one statement so two concurrent calls for the same
 * `templateId` cannot both win the same version number — the losing call's
 * `INSERT` fails the `(template_id, version)` primary key instead of
 * silently overwriting.
 */
export async function createBotTemplate(
  options: DatabaseOptions,
  input: NewBotTemplate,
): Promise<BotTemplate> {
  const templateId = requireOptionalUuid(input.templateId, "templateId");
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const name = requireNonEmpty(input.name, "name");
  const digest = requireNonEmpty(input.digest, "digest");
  const createdBy = requireNonEmpty(input.createdBy, "createdBy");
  const visibility = requireTemplateVisibility(input.visibility ?? "private", "visibility");
  if (input.manifest === null || typeof input.manifest !== "object") {
    throw new Error("manifest must be a JSON object.");
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<BotTemplateRow>(
      `WITH resolved AS (
         SELECT COALESCE($1::uuid, gen_random_uuid()) AS template_id
       ), next_version AS (
         SELECT r.template_id,
                COALESCE((SELECT MAX(version) FROM bot_templates WHERE template_id = r.template_id), 0) + 1 AS version
         FROM resolved r
       )
       INSERT INTO bot_templates (template_id, version, tenant_id, name, manifest, digest, visibility, created_by)
       SELECT template_id, version, $2, $3, $4::jsonb, $5, $6, $7
       FROM next_version
       RETURNING ${botTemplateColumns}`,
      [templateId, tenantId, name, JSON.stringify(input.manifest), digest, visibility, createdBy],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createBotTemplate did not return a persisted row.");
    }
    return toBotTemplate(row);
  });
}

export async function getBotTemplate(
  options: DatabaseOptions,
  templateId: string,
  version: number,
): Promise<BotTemplate | null> {
  const normalizedTemplateId = requireUuid(templateId, "templateId");
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("version must be a positive integer.");
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<BotTemplateRow>(
      `SELECT ${botTemplateColumns} FROM bot_templates WHERE template_id = $1 AND version = $2`,
      [normalizedTemplateId, version],
    );
    return result.rows[0] === undefined ? null : toBotTemplate(result.rows[0]);
  });
}

/** The highest-versioned row for a template id, or null if it doesn't exist. */
export async function getLatestBotTemplate(
  options: DatabaseOptions,
  templateId: string,
): Promise<BotTemplate | null> {
  const normalizedTemplateId = requireUuid(templateId, "templateId");

  return withPool(options, async (pool) => {
    const result = await pool.query<BotTemplateRow>(
      `SELECT ${botTemplateColumns} FROM bot_templates
       WHERE template_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [normalizedTemplateId],
    );
    return result.rows[0] === undefined ? null : toBotTemplate(result.rows[0]);
  });
}

/**
 * All versions for a tenant (optionally narrowed to one template id),
 * newest first. Callers that only want the latest version per template
 * should group client-side or call `getLatestBotTemplate` per id — this
 * layer stays a plain row list, no aggregation.
 */
export async function listBotTemplates(
  options: DatabaseOptions,
  filter: BotTemplateListFilter,
): Promise<BotTemplate[]> {
  const tenantId = requireNonEmpty(filter.tenantId, "tenantId");
  const conditions = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];

  if (filter.templateId !== undefined) {
    params.push(requireUuid(filter.templateId, "templateId"));
    conditions.push(`template_id = $${params.length}`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<BotTemplateRow>(
      `SELECT ${botTemplateColumns} FROM bot_templates
       WHERE ${conditions.join(" AND ")}
       ORDER BY template_id, version DESC`,
      params,
    );
    return result.rows.map(toBotTemplate);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/db templates — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        createBotTemplate(options, {
          tenantId: "basileia",
          name: "T",
          manifest: {},
          digest: "d",
          createdBy: "human:1",
        }),
      ).rejects.toThrow(/connectionString/);
      await expect(listBotTemplates(options, { tenantId: "basileia" })).rejects.toThrow(
        /connectionString/,
      );
    });

    it("rejects empty tenantId/name/digest/createdBy on createBotTemplate", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createBotTemplate(live, { tenantId: "   ", name: "T", manifest: {}, digest: "d", createdBy: "human:1" }),
      ).rejects.toThrow(/tenantId/);
      await expect(
        createBotTemplate(live, { tenantId: "t", name: "   ", manifest: {}, digest: "d", createdBy: "human:1" }),
      ).rejects.toThrow(/name/);
      await expect(
        createBotTemplate(live, { tenantId: "t", name: "T", manifest: {}, digest: "   ", createdBy: "human:1" }),
      ).rejects.toThrow(/digest/);
      await expect(
        createBotTemplate(live, { tenantId: "t", name: "T", manifest: {}, digest: "d", createdBy: "   " }),
      ).rejects.toThrow(/createdBy/);
    });

    it("rejects a non-object manifest", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createBotTemplate(live, {
          tenantId: "t",
          name: "T",
          manifest: null as unknown as Record<string, unknown>,
          digest: "d",
          createdBy: "human:1",
        }),
      ).rejects.toThrow(/manifest/);
    });

    it("rejects a malformed templateId", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createBotTemplate(live, {
          templateId: "not-a-uuid",
          tenantId: "t",
          name: "T",
          manifest: {},
          digest: "d",
          createdBy: "human:1",
        }),
      ).rejects.toThrow(/templateId/);
      await expect(getBotTemplate(live, "not-a-uuid", 1)).rejects.toThrow(/templateId/);
    });

    it("rejects a non-positive version on getBotTemplate", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(getBotTemplate(live, "11111111-1111-1111-1111-111111111111", 0)).rejects.toThrow(
        /version/,
      );
    });

    it("rejects a malformed visibility value", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createBotTemplate(live, {
          tenantId: "t",
          name: "T",
          manifest: {},
          digest: "d",
          createdBy: "human:1",
          visibility: "public" as TemplateVisibility,
        }),
      ).rejects.toThrow(/visibility/);
    });
  });
}

/**
 * Real Postgres-backed CRUD tests, in-source rather than a separate
 * `templates.test.ts` (Owned_Paths for TASK-276 names this file, not a
 * sibling test file — see this task's dossier). Skipped entirely when
 * `DATABASE_URL` is unset, same gate `roles.test.ts` uses for its own
 * integration suite. Uses `withPool` (the shared-pool accessor, already
 * imported above) for raw fixture/cleanup queries rather than a `new
 * Pool(...)` of its own — `database.test.ts`'s TASK-199 liveness check
 * (`accessor modules do not construct their own Pool`) correctly rejects
 * any non-`.test.ts` file that does, and this file is a real accessor
 * module, not a test file exempted from that rule.
 */
if (import.meta.vitest) {
  const { describe, it, expect, beforeAll, afterAll } = import.meta.vitest;

  const connectionString = process.env.DATABASE_URL;
  const integration = connectionString === undefined ? describe.skip : describe;
  const dbOptions: DatabaseOptions = { connectionString: connectionString ?? "" };

  integration("@oikonomos/db templates — real Postgres CRUD (TASK-276)", () => {
    const tenantId = "task-276-templates-suite";

    async function cleanup(): Promise<void> {
      await withPool(dbOptions, (pool) => pool.query(`DELETE FROM bot_templates WHERE tenant_id = $1`, [tenantId]));
    }

    beforeAll(cleanup);
    afterAll(cleanup);

    it("creates a template at version 1 and reads it back byte-identical", async () => {
      const created = await createBotTemplate(
        { connectionString: connectionString! },
        { tenantId, name: "Support Bot", manifest: { identity: { name: "s" } }, digest: "digest-1", createdBy: "human:1" },
      );

      expect(created.version).toBe(1);
      expect(created.visibility).toBe("private");
      expect(created.manifest).toEqual({ identity: { name: "s" } });

      const fetched = await getBotTemplate({ connectionString: connectionString! }, created.templateId, 1);
      expect(fetched).toEqual(created);
    });

    it("auto-increments version on repeated export of the same templateId", async () => {
      const v1 = await createBotTemplate(
        { connectionString: connectionString! },
        { tenantId, name: "Versioned Bot", manifest: { v: 1 }, digest: "digest-v1", createdBy: "human:1" },
      );
      const v2 = await createBotTemplate(
        { connectionString: connectionString! },
        { templateId: v1.templateId, tenantId, name: "Versioned Bot", manifest: { v: 2 }, digest: "digest-v2", createdBy: "human:1" },
      );

      expect(v2.templateId).toBe(v1.templateId);
      expect(v2.version).toBe(2);

      const latest = await getLatestBotTemplate({ connectionString: connectionString! }, v1.templateId);
      expect(latest?.version).toBe(2);
      expect(latest?.digest).toBe("digest-v2");
    });

    it("getBotTemplate returns null for an unknown template/version", async () => {
      const result = await getBotTemplate(
        { connectionString: connectionString! },
        "00000000-0000-0000-0000-000000000000",
        1,
      );
      expect(result).toBeNull();
    });

    it("lists templates scoped to a tenant, optionally filtered by templateId", async () => {
      const a = await createBotTemplate(
        { connectionString: connectionString! },
        { tenantId, name: "List A", manifest: {}, digest: "digest-list-a", createdBy: "human:1" },
      );
      const b = await createBotTemplate(
        { connectionString: connectionString! },
        { tenantId, name: "List B", manifest: {}, digest: "digest-list-b", createdBy: "human:1" },
      );

      const all = await listBotTemplates({ connectionString: connectionString! }, { tenantId });
      const ids = all.map((t) => t.templateId);
      expect(ids).toContain(a.templateId);
      expect(ids).toContain(b.templateId);

      const onlyA = await listBotTemplates(
        { connectionString: connectionString! },
        { tenantId, templateId: a.templateId },
      );
      expect(onlyA.map((t) => t.templateId)).toEqual([a.templateId]);
    });

    it("rejects a visibility value the CHECK constraint does not allow, at the database", async () => {
      await cleanup();
      await expect(
        withPool(dbOptions, (pool) =>
          pool.query(
            `INSERT INTO bot_templates (template_id, version, tenant_id, name, manifest, digest, visibility, created_by)
             VALUES (gen_random_uuid(), 1, $1, 'x', '{}'::jsonb, 'd', 'public', 'human:1')`,
            [tenantId],
          ),
        ),
      ).rejects.toThrow();
    });
  });
}
