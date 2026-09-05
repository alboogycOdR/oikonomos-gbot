import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

/**
 * TASK-176 / Addendum F §3.2 (N12) — skill bodies and their supporting
 * frontmatter are prompt material only. This data layer persists and returns
 * them verbatim; it makes no authorization or policy decision from them.
 */
export const skillStatuses = ["active", "archived"] as const;
export type SkillStatus = (typeof skillStatuses)[number];

export interface NewSkill {
  tenantId?: string;
  name: string;
  description: string;
  whenToUse?: string | null;
  body: string;
  inputs?: Record<string, unknown>[];
  access?: string[];
  approvals?: string[];
  failurePolicy?: Record<string, unknown>;
  status?: SkillStatus;
}

export interface Skill {
  skillId: string;
  tenantId: string;
  name: string;
  description: string;
  whenToUse: string | null;
  body: string;
  inputs: Record<string, unknown>[];
  access: string[];
  approvals: string[];
  failurePolicy: Record<string, unknown>;
  version: number;
  status: SkillStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateSkill {
  name?: string;
  description?: string;
  whenToUse?: string | null;
  body?: string;
  inputs?: Record<string, unknown>[];
  access?: string[];
  approvals?: string[];
  failurePolicy?: Record<string, unknown>;
  status?: SkillStatus;
}

interface SkillRow extends QueryResultRow {
  skill_id: string;
  tenant_id: string;
  name: string;
  description: string;
  when_to_use: string | null;
  body: string;
  inputs: Record<string, unknown>[];
  access: string[];
  approvals: string[];
  failure_policy: Record<string, unknown>;
  version: number;
  status: SkillStatus;
  created_at: Date;
  updated_at: Date;
}

const skillColumns = `skill_id, tenant_id, name, description, when_to_use, body,
       inputs, access, approvals, failure_policy, version, status, created_at, updated_at`;
const qualifiedSkillColumns = `skills.skill_id, skills.tenant_id, skills.name, skills.description, skills.when_to_use, skills.body,
       skills.inputs, skills.access, skills.approvals, skills.failure_policy, skills.version, skills.status, skills.created_at, skills.updated_at`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

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

function requireSkillName(value: string): string {
  const name = requireNonEmpty(value, "name");
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error("name must be a slash-token matching ^[a-z0-9][a-z0-9-]{1,63}$.");
  }
  return name;
}

function requireStatus(value: SkillStatus): SkillStatus {
  if (!skillStatuses.includes(value)) {
    throw new Error(`status must be one of: ${skillStatuses.join(", ")}.`);
  }
  return value;
}

function toSkill(row: SkillRow): Skill {
  return {
    skillId: row.skill_id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    whenToUse: row.when_to_use,
    body: row.body,
    inputs: row.inputs,
    access: row.access,
    approvals: row.approvals,
    failurePolicy: row.failure_policy,
    version: row.version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function withPool<T>(options: DatabaseOptions, fn: (pool: Pool) => Promise<T>): Promise<T> {
  if (options.connectionString.trim().length === 0) {
    throw new Error("Database connectionString must not be empty.");
  }

  const pool = new Pool({
    connectionString: options.connectionString,
    ...defaultPoolConfig,
    ...options.poolConfig,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function createSkill(options: DatabaseOptions, input: NewSkill): Promise<Skill> {
  const name = requireSkillName(input.name);
  const description = requireNonEmpty(input.description, "description");
  const body = requireNonEmpty(input.body, "body");
  const status = requireStatus(input.status ?? "active");

  return withPool(options, async (pool) => {
    const result = await pool.query<SkillRow>(
      `INSERT INTO skills
         (tenant_id, name, description, when_to_use, body, inputs, access, approvals, failure_policy, status)
       VALUES (COALESCE($1, 'basileia'), $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
       RETURNING ${skillColumns}`,
      [
        input.tenantId ?? null, name, description, input.whenToUse ?? null, body,
        JSON.stringify(input.inputs ?? []), JSON.stringify(input.access ?? []),
        JSON.stringify(input.approvals ?? []), JSON.stringify(input.failurePolicy ?? {}), status,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("createSkill did not return a persisted row.");
    return toSkill(row);
  });
}

export async function getSkill(options: DatabaseOptions, skillId: string): Promise<Skill | null> {
  const normalizedSkillId = requireUuid(skillId, "skillId");
  return withPool(options, async (pool) => {
    const result = await pool.query<SkillRow>(
      `SELECT ${skillColumns} FROM skills WHERE skill_id = $1`, [normalizedSkillId],
    );
    return result.rows[0] === undefined ? null : toSkill(result.rows[0]);
  });
}

export interface SkillListFilter {
  tenantId: string;
  status?: SkillStatus;
}

export async function listSkills(options: DatabaseOptions, filter: SkillListFilter): Promise<Skill[]> {
  const tenantId = requireNonEmpty(filter.tenantId, "tenantId");
  const conditions = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  if (filter.status !== undefined) {
    params.push(requireStatus(filter.status));
    conditions.push(`status = $${params.length}`);
  }
  return withPool(options, async (pool) => {
    const result = await pool.query<SkillRow>(
      `SELECT ${skillColumns} FROM skills WHERE ${conditions.join(" AND ")} ORDER BY name`, params,
    );
    return result.rows.map(toSkill);
  });
}

export async function updateSkill(
  options: DatabaseOptions, skillId: string, input: UpdateSkill,
): Promise<Skill | null> {
  const normalizedSkillId = requireUuid(skillId, "skillId");
  const updates: string[] = [];
  const params: unknown[] = [normalizedSkillId];
  const set = (column: string, value: unknown, cast = "") => {
    params.push(value);
    updates.push(`${column} = $${params.length}${cast}`);
  };

  if (input.name !== undefined) set("name", requireSkillName(input.name));
  if (input.description !== undefined) set("description", requireNonEmpty(input.description, "description"));
  if (input.whenToUse !== undefined) set("when_to_use", input.whenToUse);
  if (input.body !== undefined) set("body", requireNonEmpty(input.body, "body"));
  if (input.inputs !== undefined) set("inputs", JSON.stringify(input.inputs), "::jsonb");
  if (input.access !== undefined) set("access", JSON.stringify(input.access), "::jsonb");
  if (input.approvals !== undefined) set("approvals", JSON.stringify(input.approvals), "::jsonb");
  if (input.failurePolicy !== undefined) set("failure_policy", JSON.stringify(input.failurePolicy), "::jsonb");
  if (input.status !== undefined) set("status", requireStatus(input.status));
  if (updates.length === 0) throw new Error("updateSkill requires at least one field.");
  updates.push("version = version + 1", "updated_at = now()");

  return withPool(options, async (pool) => {
    const result = await pool.query<SkillRow>(
      `UPDATE skills SET ${updates.join(", ")} WHERE skill_id = $1 RETURNING ${skillColumns}`,
      params,
    );
    return result.rows[0] === undefined ? null : toSkill(result.rows[0]);
  });
}

export async function setEnabledForRole(
  options: DatabaseOptions, roleId: string, skillId: string, enabled: boolean,
): Promise<void> {
  const normalizedRoleId = requireNonEmpty(roleId, "roleId");
  const normalizedSkillId = requireUuid(skillId, "skillId");
  return withPool(options, async (pool) => {
    await pool.query(
      `INSERT INTO role_skills (role_id, skill_id, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (role_id, skill_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [normalizedRoleId, normalizedSkillId, enabled],
    );
  });
}

export async function listEnabledForRole(
  options: DatabaseOptions, roleId: string,
): Promise<Skill[]> {
  const normalizedRoleId = requireNonEmpty(roleId, "roleId");
  return withPool(options, async (pool) => {
    const result = await pool.query<SkillRow>(
      `SELECT ${qualifiedSkillColumns} FROM skills
       INNER JOIN role_skills ON role_skills.skill_id = skills.skill_id
       WHERE role_skills.role_id = $1 AND role_skills.enabled = true
       ORDER BY skills.name`,
      [normalizedRoleId],
    );
    return result.rows.map(toSkill);
  });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const live: DatabaseOptions = { connectionString: "postgres://x" };

  describe("@oikonomos/db skills — input validation (no DB required)", () => {
    it("rejects a slash-token name that would violate the database constraint", async () => {
      await expect(createSkill(live, { name: "Bad_name", description: "d", body: "b" }))
        .rejects.toThrow(/slash-token/);
    });

    it("rejects invalid skill IDs and empty role IDs before opening a pool", async () => {
      await expect(getSkill(live, "not-a-uuid")).rejects.toThrow(/UUID/);
      await expect(setEnabledForRole(live, " ", "11111111-1111-1111-1111-111111111111", true))
        .rejects.toThrow(/roleId/);
      await expect(listEnabledForRole(live, " ")).rejects.toThrow(/roleId/);
    });
  });
}
