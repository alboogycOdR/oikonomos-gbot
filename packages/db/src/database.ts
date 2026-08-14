import { Pool, type PoolConfig, type QueryResultRow } from "pg";

import type { Capability, RoleGrant, RiskTier } from "./types.js";

/**
 * Conservative in-process limits for PostgreSQL and PgBouncer deployments.
 *
 * Each application process opens at most ten connections, returns idle
 * connections after ten seconds, and fails a blocked checkout after five
 * seconds. Keep the process count and this `max` coordinated with the
 * PgBouncer pool size rather than increasing this value per request.
 */
export const defaultPoolConfig: Pick<
  PoolConfig,
  "max" | "idleTimeoutMillis" | "connectionTimeoutMillis" | "maxUses"
> = {
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  maxUses: 7_500,
};

export interface DatabaseOptions {
  connectionString: string;
  poolConfig?: Partial<typeof defaultPoolConfig>;
}

interface CapabilityRow extends QueryResultRow {
  capability_id: string;
  description: string;
  default_tier: RiskTier;
  adapter: string;
  enabled: boolean;
}

interface RoleGrantRow extends QueryResultRow {
  role_id: string;
  capability_id: string;
  max_tier: RiskTier;
  constraints: Record<string, unknown>;
}

function toCapability(row: CapabilityRow): Capability {
  return {
    capabilityId: row.capability_id,
    description: row.description,
    defaultTier: row.default_tier,
    adapter: row.adapter,
    enabled: row.enabled,
  };
}

function toRoleGrant(row: RoleGrantRow): RoleGrant {
  return {
    roleId: row.role_id,
    capabilityId: row.capability_id,
    maxTier: row.max_tier,
    constraints: row.constraints,
  };
}

export class Database {
  readonly #pool: Pool;

  public constructor(options: DatabaseOptions) {
    if (options.connectionString.trim().length === 0) {
      throw new Error("Database connectionString must not be empty.");
    }

    this.#pool = new Pool({
      connectionString: options.connectionString,
      ...defaultPoolConfig,
      ...options.poolConfig,
    });
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  public async getCapability(capabilityId: string): Promise<Capability | null> {
    const result = await this.#pool.query<CapabilityRow>(
      `SELECT capability_id, description, default_tier, adapter, enabled
       FROM capabilities
       WHERE capability_id = $1`,
      [capabilityId],
    );
    return result.rows[0] === undefined ? null : toCapability(result.rows[0]);
  }

  public async listCapabilities(): Promise<Capability[]> {
    const result = await this.#pool.query<CapabilityRow>(
      `SELECT capability_id, description, default_tier, adapter, enabled
       FROM capabilities
       ORDER BY capability_id`,
    );
    return result.rows.map(toCapability);
  }

  public async upsertCapability(capability: Capability): Promise<Capability> {
    const result = await this.#pool.query<CapabilityRow>(
      `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (capability_id) DO UPDATE SET
         description = EXCLUDED.description,
         default_tier = EXCLUDED.default_tier,
         adapter = EXCLUDED.adapter,
         enabled = EXCLUDED.enabled
       RETURNING capability_id, description, default_tier, adapter, enabled`,
      [
        capability.capabilityId,
        capability.description,
        capability.defaultTier,
        capability.adapter,
        capability.enabled,
      ],
    );
    return toCapability(result.rows[0]);
  }

  public async getRoleGrant(
    roleId: string,
    capabilityId: string,
  ): Promise<RoleGrant | null> {
    const result = await this.#pool.query<RoleGrantRow>(
      `SELECT role_id, capability_id, max_tier, constraints
       FROM role_grants
       WHERE role_id = $1 AND capability_id = $2`,
      [roleId, capabilityId],
    );
    return result.rows[0] === undefined ? null : toRoleGrant(result.rows[0]);
  }

  public async listRoleGrants(roleId: string): Promise<RoleGrant[]> {
    const result = await this.#pool.query<RoleGrantRow>(
      `SELECT role_id, capability_id, max_tier, constraints
       FROM role_grants
       WHERE role_id = $1
       ORDER BY capability_id`,
      [roleId],
    );
    return result.rows.map(toRoleGrant);
  }

  public async upsertRoleGrant(roleGrant: RoleGrant): Promise<RoleGrant> {
    const result = await this.#pool.query<RoleGrantRow>(
      `INSERT INTO role_grants (role_id, capability_id, max_tier, constraints)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (role_id, capability_id) DO UPDATE SET
         max_tier = EXCLUDED.max_tier,
         constraints = EXCLUDED.constraints
       RETURNING role_id, capability_id, max_tier, constraints`,
      [
        roleGrant.roleId,
        roleGrant.capabilityId,
        roleGrant.maxTier,
        JSON.stringify(roleGrant.constraints),
      ],
    );
    return toRoleGrant(result.rows[0]);
  }
}
