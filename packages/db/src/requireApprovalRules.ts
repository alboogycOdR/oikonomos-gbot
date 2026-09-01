import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

/**
 * TASK-084 / Addendum F §5.4 (F15) — Require Approval rules. `roleId: null`
 * means whole-tenant. This module is data access only: evaluating a rule
 * against a live action and slotting it into the total precedence order
 * (rank 3 of 6) is TASK-086 (packages/policy)'s job, not this one's.
 */
export interface NewRequireApprovalRule {
  tenantId?: string;
  roleId?: string | null;
  capabilityId: string;
  targetPredicate?: Record<string, unknown>;
  enabled?: boolean;
  createdBy?: string | null;
}

export interface RequireApprovalRule {
  ruleId: string;
  tenantId: string;
  roleId: string | null;
  capabilityId: string;
  targetPredicate: Record<string, unknown>;
  enabled: boolean;
  createdBy: string | null;
  createdAt: Date;
}

interface RequireApprovalRuleRow extends QueryResultRow {
  rule_id: string;
  tenant_id: string;
  role_id: string | null;
  capability_id: string;
  target_predicate: Record<string, unknown>;
  enabled: boolean;
  created_by: string | null;
  created_at: Date;
}

const ruleColumns = `rule_id, tenant_id, role_id, capability_id, target_predicate,
       enabled, created_by, created_at`;

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

function toRule(row: RequireApprovalRuleRow): RequireApprovalRule {
  return {
    ruleId: row.rule_id,
    tenantId: row.tenant_id,
    roleId: row.role_id,
    capabilityId: row.capability_id,
    targetPredicate: row.target_predicate,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function withPool<T>(
  options: DatabaseOptions,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
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

export async function createRequireApprovalRule(
  options: DatabaseOptions,
  input: NewRequireApprovalRule,
): Promise<RequireApprovalRule> {
  const capabilityId = requireNonEmpty(input.capabilityId, "capabilityId");
  const roleId =
    input.roleId === undefined || input.roleId === null
      ? null
      : requireNonEmpty(input.roleId, "roleId");

  return withPool(options, async (pool) => {
    const result = await pool.query<RequireApprovalRuleRow>(
      `INSERT INTO require_approval_rules
         (tenant_id, role_id, capability_id, target_predicate, enabled, created_by)
       VALUES (COALESCE($1, 'basileia'), $2, $3, $4::jsonb, $5, $6)
       RETURNING ${ruleColumns}`,
      [
        input.tenantId ?? null,
        roleId,
        capabilityId,
        JSON.stringify(input.targetPredicate ?? {}),
        input.enabled ?? true,
        input.createdBy ?? null,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createRequireApprovalRule did not return a persisted row.");
    }
    return toRule(row);
  });
}

export async function getRequireApprovalRule(
  options: DatabaseOptions,
  ruleId: string,
): Promise<RequireApprovalRule | null> {
  const normalizedRuleId = requireUuid(ruleId, "ruleId");

  return withPool(options, async (pool) => {
    const result = await pool.query<RequireApprovalRuleRow>(
      `SELECT ${ruleColumns} FROM require_approval_rules WHERE rule_id = $1`,
      [normalizedRuleId],
    );
    return result.rows[0] === undefined ? null : toRule(result.rows[0]);
  });
}

export interface RequireApprovalRuleListFilter {
  tenantId: string;
  capabilityId?: string;
  /** Omit to get every rule; pass explicitly to scope to one role or to whole-tenant (null) rules. */
  roleId?: string | null;
  enabledOnly?: boolean;
}

/**
 * List rules for a tenant, optionally scoped to a capability and/or role.
 * Passing `roleId: null` explicitly returns only whole-tenant rules;
 * omitting `roleId` returns rules for every role plus whole-tenant ones —
 * the caller (policy's rank-3 evaluator) decides which shape it needs.
 */
export async function listRequireApprovalRules(
  options: DatabaseOptions,
  filter: RequireApprovalRuleListFilter,
): Promise<RequireApprovalRule[]> {
  const tenantId = requireNonEmpty(filter.tenantId, "tenantId");
  const conditions = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];

  if (filter.capabilityId !== undefined) {
    params.push(requireNonEmpty(filter.capabilityId, "capabilityId"));
    conditions.push(`capability_id = $${params.length}`);
  }
  if (filter.roleId !== undefined) {
    if (filter.roleId === null) {
      conditions.push(`role_id IS NULL`);
    } else {
      params.push(requireNonEmpty(filter.roleId, "roleId"));
      conditions.push(`role_id = $${params.length}`);
    }
  }
  if (filter.enabledOnly === true) {
    conditions.push(`enabled = true`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<RequireApprovalRuleRow>(
      `SELECT ${ruleColumns} FROM require_approval_rules
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at, rule_id`,
      params,
    );
    return result.rows.map(toRule);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/db requireApprovalRules — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        createRequireApprovalRule(options, { capabilityId: "cap" }),
      ).rejects.toThrow(/connectionString/);
      await expect(
        getRequireApprovalRule(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
      await expect(
        listRequireApprovalRules(options, { tenantId: "basileia" }),
      ).rejects.toThrow(/connectionString/);
    });

    it("rejects an empty capabilityId on createRequireApprovalRule", async () => {
      await expect(
        createRequireApprovalRule({ connectionString: "postgres://x" }, { capabilityId: "   " }),
      ).rejects.toThrow(/capabilityId/);
    });

    it("rejects a non-UUID ruleId", async () => {
      await expect(
        getRequireApprovalRule({ connectionString: "postgres://x" }, "not-a-uuid"),
      ).rejects.toThrow(/UUID/);
    });

    it("rejects an empty tenantId on listRequireApprovalRules", async () => {
      await expect(
        listRequireApprovalRules({ connectionString: "postgres://x" }, { tenantId: "   " }),
      ).rejects.toThrow(/tenantId/);
    });
  });
}
