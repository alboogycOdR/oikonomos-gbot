import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";

/**
 * TASK-084 / Addendum F §3.1 (F4) — `role_id` becomes a real D0 identity.
 *
 * N12 (§3.2/F5): `description` is prompt material, ADVISORY ONLY. It is
 * stored and returned verbatim below, but no function in this file (or in
 * routines.ts / roleMessages.ts / requireApprovalRules.ts) may branch on
 * it for an authorization decision — role_grants remains the enforcer. See
 * the source-scan liveness test in roles.test.ts.
 */
export const roleStatuses = ["active", "hidden", "deleted"] as const;

export type RoleStatus = (typeof roleStatuses)[number];

/** Human-readable bot names stay concise across the API and MCP surfaces. */
export const MAX_ROLE_NAME_LENGTH = 100;

export interface NewRole {
  roleId: string;
  tenantId?: string;
  name: string;
  title: string;
  description?: string;
  status?: RoleStatus;
}

export interface Role {
  roleId: string;
  tenantId: string;
  name: string;
  title: string;
  description: string;
  /** Optional custom system-prompt material; null means no custom persona. */
  instructions: string | null;
  /**
   * Provider this bot runs on. NULL means "use the configured platform
   * default" rather than a copied literal (TASK-213) — so a bot that has
   * never been given an explicit choice stays distinguishable from one
   * deliberately pinned to whatever the default happens to be today. That
   * distinction is what makes changing the default reversible per bot.
   */
  provider: string | null;
  /** Model within that provider; NULL follows the provider's own default. */
  model: string | null;
  status: RoleStatus;
  createdAt: Date;
  updatedAt: Date;
}

interface RoleRow extends QueryResultRow {
  role_id: string;
  tenant_id: string;
  name: string;
  title: string;
  description: string;
  instructions: string | null;
  provider: string | null;
  model: string | null;
  status: RoleStatus;
  created_at: Date;
  updated_at: Date;
}

const roleColumns = `role_id, tenant_id, name, title, description, instructions, provider, model, status, created_at, updated_at`;

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function requireRoleStatus(value: RoleStatus, field: string): RoleStatus {
  if (!roleStatuses.includes(value)) {
    throw new Error(`${field} must be one of: ${roleStatuses.join(", ")}.`);
  }
  return value;
}

function toRole(row: RoleRow): Role {
  return {
    roleId: row.role_id,
    tenantId: row.tenant_id,
    name: row.name,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    provider: row.provider ?? null,
    model: row.model ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create a role. Upserts on `role_id` conflict (an idempotent seed/backfill
 * path is expected to call this repeatedly) but only ever touches the name/
 * title/description/status fields — never tenant_id, never created_at.
 */
export async function createRole(
  options: DatabaseOptions,
  input: NewRole,
): Promise<Role> {
  const roleId = requireNonEmpty(input.roleId, "roleId");
  const name = requireNonEmpty(input.name, "name");
  const title = requireNonEmpty(input.title, "title");
  const description = input.description ?? "";
  const status = requireRoleStatus(input.status ?? "active", "status");

  return withPool(options, async (pool) => {
    const result = await pool.query<RoleRow>(
      `INSERT INTO roles (role_id, tenant_id, name, title, description, status)
       VALUES ($1, COALESCE($2, 'basileia'), $3, $4, $5, $6)
       ON CONFLICT (role_id) DO UPDATE SET
         name = EXCLUDED.name,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         updated_at = now()
       RETURNING ${roleColumns}`,
      [roleId, input.tenantId ?? null, name, title, description, status],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createRole did not return a persisted row.");
    }
    return toRole(row);
  });
}

export async function getRole(
  options: DatabaseOptions,
  roleId: string,
): Promise<Role | null> {
  const normalizedRoleId = requireNonEmpty(roleId, "roleId");

  return withPool(options, async (pool) => {
    const result = await pool.query<RoleRow>(
      `SELECT ${roleColumns} FROM roles WHERE role_id = $1`,
      [normalizedRoleId],
    );
    return result.rows[0] === undefined ? null : toRole(result.rows[0]);
  });
}

/**
 * Persist optional role-specific system-prompt material. An empty string is
 * intentional: it clears a previously configured custom instruction while
 * preserving the nullable schema's distinction for pre-existing unset roles.
 */
export async function updateRoleInstructions(
  options: DatabaseOptions,
  roleId: string,
  instructions: string,
): Promise<Role | null> {
  const normalizedRoleId = requireNonEmpty(roleId, "roleId");

  return withPool(options, async (pool) => {
    const result = await pool.query<RoleRow>(
      `UPDATE roles
       SET instructions = $2,
           updated_at = now()
       WHERE role_id = $1
       RETURNING ${roleColumns}`,
      [normalizedRoleId, instructions],
    );
    return result.rows[0] === undefined ? null : toRole(result.rows[0]);
  });
}

/** Persist a bot's display name. Unlike instructions, a name cannot be blank. */
export async function updateRoleName(
  options: DatabaseOptions,
  roleId: string,
  name: string,
): Promise<Role | null> {
  const normalizedRoleId = requireNonEmpty(roleId, "roleId");
  const normalizedName = requireNonEmpty(name, "name");
  if (normalizedName.length > MAX_ROLE_NAME_LENGTH) {
    throw new Error(`name must be at most ${MAX_ROLE_NAME_LENGTH} characters.`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<RoleRow>(
      `UPDATE roles
       SET name = $2,
           updated_at = now()
       WHERE role_id = $1
       RETURNING ${roleColumns}`,
      [normalizedRoleId, normalizedName],
    );
    return result.rows[0] === undefined ? null : toRole(result.rows[0]);
  });
}

export interface RoleListFilter {
  tenantId: string;
  status?: RoleStatus;
}

/**
 * List roles for a tenant. `tenantId` is required (not optional) — every
 * read in this module is tenant-scoped per this task's acceptance criteria;
 * there is no "list all tenants" escape hatch.
 */
export async function listRoles(
  options: DatabaseOptions,
  filter: RoleListFilter,
): Promise<Role[]> {
  const tenantId = requireNonEmpty(filter.tenantId, "tenantId");
  const conditions = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];

  if (filter.status !== undefined) {
    params.push(requireRoleStatus(filter.status, "status"));
    conditions.push(`status = $${params.length}`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<RoleRow>(
      `SELECT ${roleColumns} FROM roles
       WHERE ${conditions.join(" AND ")}
       ORDER BY role_id`,
      params,
    );
    return result.rows.map(toRole);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/db roles — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        createRole(options, { roleId: "r1", name: "R1", title: "R1" }),
      ).rejects.toThrow(/connectionString/);
      await expect(getRole(options, "r1")).rejects.toThrow(/connectionString/);
      await expect(updateRoleInstructions(options, "r1", "persona")).rejects.toThrow(/connectionString/);
      await expect(updateRoleName(options, "r1", "Renamed")).rejects.toThrow(/connectionString/);
      await expect(listRoles(options, { tenantId: "basileia" })).rejects.toThrow(
        /connectionString/,
      );
    });

    it("rejects empty roleId/name/title on createRole", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createRole(live, { roleId: "   ", name: "R1", title: "R1" }),
      ).rejects.toThrow(/roleId/);
      await expect(
        createRole(live, { roleId: "r1", name: "   ", title: "R1" }),
      ).rejects.toThrow(/name/);
      await expect(
        createRole(live, { roleId: "r1", name: "R1", title: "   " }),
      ).rejects.toThrow(/title/);
    });

    it("rejects an invalid status on createRole/listRoles", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createRole(live, {
          roleId: "r1",
          name: "R1",
          title: "R1",
          status: "deleted-typo" as RoleStatus,
        }),
      ).rejects.toThrow(/status/);
      await expect(
        listRoles(live, { tenantId: "basileia", status: "gone" as RoleStatus }),
      ).rejects.toThrow(/status/);
    });

    it("rejects an empty roleId on getRole and an empty tenantId on listRoles", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(getRole(live, "   ")).rejects.toThrow(/roleId/);
      await expect(updateRoleInstructions(live, "   ", "persona")).rejects.toThrow(/roleId/);
      await expect(updateRoleName(live, "   ", "Renamed")).rejects.toThrow(/roleId/);
      await expect(listRoles(live, { tenantId: "   " })).rejects.toThrow(/tenantId/);
    });

    it("rejects empty and excessively long role names", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(updateRoleName(live, "r1", "   ")).rejects.toThrow(/name must not be empty/);
      await expect(updateRoleName(live, "r1", "x".repeat(MAX_ROLE_NAME_LENGTH + 1))).rejects.toThrow(/at most/);
    });
  });
}


/** Platform default provider when a role has not chosen one (TASK-213). */
export const DEFAULT_ROLE_PROVIDER_ENV = "OIK_DEFAULT_ROLE_PROVIDER";
/** Platform default model when a role has not chosen one. */
export const DEFAULT_ROLE_MODEL_ENV = "OIK_DEFAULT_ROLE_MODEL";

/**
 * Resolves which provider and model a role actually runs on.
 *
 * A role's own values win; otherwise the configured platform default applies.
 * The default is CONFIGURATION, not a literal, so switching every bot is an
 * operational change rather than a deploy — and, critically, so it can be
 * switched BACK the same way. The user's decision is that Gemini eventually
 * becomes the default for all bots including existing ones; this function is
 * the single place that decision takes effect, and it is deliberately not
 * flipped yet: TASK-213's own acceptance criteria forbid flipping before
 * TASK-214 proves a tool-using bot actually works on Gemini.
 *
 * Falls back to Claude when nothing is configured. An unset default must not
 * silently move existing bots onto a different provider.
 */
export function resolveRoleRuntime(
  role: Pick<Role, "provider" | "model">,
  env: Record<string, string | undefined> = process.env,
): { readonly provider: string; readonly model: string | null } {
  const provider = role.provider?.trim() || env[DEFAULT_ROLE_PROVIDER_ENV]?.trim() || "claude";
  const model = role.model?.trim() || env[DEFAULT_ROLE_MODEL_ENV]?.trim() || null;
  return { provider, model };
}
