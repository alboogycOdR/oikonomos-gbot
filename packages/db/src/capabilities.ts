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

/** DB-owned registration boundary; callers never issue registration SQL. */
export interface ConnectorRegistrationStore {
  register(rows: ConnectorRegistrationRows): Promise<void>;
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
    async register(rows: ConnectorRegistrationRows): Promise<void> {
      const client = await pool.connect();
      const adapter = rows.adapter ?? adapterFor(rows.connectorId);
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
