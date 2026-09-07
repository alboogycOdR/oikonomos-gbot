import type { Pool, PoolClient } from "pg";

import type { RiskTier } from "./types.js";

export interface ConnectorCapabilityRow {
  readonly capabilityId: string;
  readonly description: string;
  readonly defaultTier: RiskTier;
  readonly enabled: boolean;
}

export interface ConnectorRoleGrantRow {
  readonly roleId: string;
  readonly capabilityId: string;
  readonly maxTier: RiskTier;
  readonly constraints: Record<string, unknown>;
}

export interface ConnectorRegistrationRows {
  readonly connectorId: string;
  /** Ownership tag stored on each `capabilities` row. Defaults to `mcp:<connectorId>` when omitted (ADR-013 §4). */
  readonly adapter?: string;
  readonly capabilities: readonly ConnectorCapabilityRow[];
  readonly roleGrants: readonly ConnectorRoleGrantRow[];
}

/**
 * TASK-206: a role_grants row whose target role doesn't exist YET (a
 * normal, expected state — roles and connector manifests are registered
 * independently over time, not a data-integrity problem). Skipped rather
 * than failing the whole manifest's registration.
 */
export interface SkippedRoleGrant {
  readonly roleId: string;
  readonly capabilityId: string;
  readonly reason: string;
}

export interface ConnectorRegistrationResult {
  readonly skippedRoleGrants: readonly SkippedRoleGrant[];
}

/** DB-owned registration boundary; callers never issue registration SQL. */
export interface ConnectorRegistrationStore {
  register(rows: ConnectorRegistrationRows): Promise<ConnectorRegistrationResult>;
  deregister(connectorId: string): Promise<void>;
}

function adapterFor(connectorId: string): string {
  return `mcp:${connectorId}`;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original database error is the actionable one.
  }
}

/**
 * Creates the PostgreSQL implementation of the registration port.
 * Each registration or deregistration owns exactly one transaction.
 */
export function createConnectorRegistrationStore(pool: Pool): ConnectorRegistrationStore {
  return {
    async register(rows: ConnectorRegistrationRows): Promise<ConnectorRegistrationResult> {
      const client = await pool.connect();
      const adapter = rows.adapter ?? adapterFor(rows.connectorId);
      const skippedRoleGrants: SkippedRoleGrant[] = [];
      try {
        await client.query("BEGIN");
        for (const capability of rows.capabilities) {
          const existing = await client.query<{ adapter: string }>(
            `SELECT adapter FROM capabilities WHERE capability_id = $1 FOR UPDATE`,
            [capability.capabilityId],
          );
          const owner = existing.rows[0]?.adapter;
          if (owner !== undefined && owner !== adapter) {
            throw new Error(
              `capability '${capability.capabilityId}' is already owned by '${owner}'`,
            );
          }
          await client.query(
            `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (capability_id) DO UPDATE SET
               description = EXCLUDED.description,
               default_tier = EXCLUDED.default_tier,
               adapter = EXCLUDED.adapter,
               enabled = EXCLUDED.enabled`,
            [
              capability.capabilityId,
              capability.description,
              capability.defaultTier,
              adapter,
              capability.enabled,
            ],
          );
        }
        for (const grant of rows.roleGrants) {
          // TASK-206: a role_grants row referencing a role that doesn't
          // exist YET is a normal, expected state for a partially-populated
          // deployment (roles and connector manifests register
          // independently over time), not a data-integrity error — checked
          // first (rather than inserting and catching the FK violation)
          // because Postgres aborts the whole transaction on a constraint
          // error, which would undo every capability and grant this
          // manifest already committed in this same transaction.
          const roleExists = await client.query<{ exists: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM roles WHERE role_id = $1) AS exists`,
            [grant.roleId],
          );
          if (roleExists.rows[0]?.exists !== true) {
            skippedRoleGrants.push({
              roleId: grant.roleId,
              capabilityId: grant.capabilityId,
              reason: `role '${grant.roleId}' does not exist yet`,
            });
            continue;
          }
          await client.query(
            `INSERT INTO role_grants (role_id, capability_id, max_tier, constraints)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (role_id, capability_id) DO UPDATE SET
               max_tier = EXCLUDED.max_tier,
               constraints = EXCLUDED.constraints`,
            [
              grant.roleId,
              grant.capabilityId,
              grant.maxTier,
              JSON.stringify(grant.constraints),
            ],
          );
        }
        await client.query("COMMIT");
        return { skippedRoleGrants };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async deregister(connectorId: string): Promise<void> {
      const client = await pool.connect();
      const adapter = adapterFor(connectorId);
      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM role_grants
           WHERE capability_id IN (
             SELECT capability_id FROM capabilities WHERE adapter = $1
           )`,
          [adapter],
        );
        await client.query(`DELETE FROM capabilities WHERE adapter = $1`, [adapter]);
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
