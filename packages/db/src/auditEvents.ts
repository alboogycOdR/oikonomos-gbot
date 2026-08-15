import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";
import type { RiskTier } from "./types.js";

export interface NewAuditEvent {
  tenantId?: string;
  runId?: string | null;
  at?: Date;
  actor: string;
  eventType: string;
  capability?: string | null;
  tier?: RiskTier | null;
  payload?: Record<string, unknown>;
  evidenceUri?: string | null;
}

export interface AuditEvent {
  eventId: string;
  tenantId: string;
  runId: string | null;
  at: Date;
  actor: string;
  eventType: string;
  capability: string | null;
  tier: RiskTier | null;
  payload: Record<string, unknown>;
  evidenceUri: string | null;
}

interface AuditEventRow extends QueryResultRow {
  event_id: string | number | bigint;
  tenant_id: string;
  run_id: string | null;
  at: Date;
  actor: string;
  event_type: string;
  capability: string | null;
  tier: RiskTier | null;
  payload: unknown;
  evidence_uri: string | null;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("audit_events.payload must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    eventId: String(row.event_id),
    tenantId: row.tenant_id,
    runId: row.run_id,
    at: row.at,
    actor: row.actor,
    eventType: row.event_type,
    capability: row.capability,
    tier: row.tier,
    payload: asJsonObject(row.payload),
    evidenceUri: row.evidence_uri,
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

/**
 * Append-only insert into audit_events. Write errors propagate to the caller
 * so the broker can fail the action closed (ADR-001 R3).
 */
export async function insertAuditEvent(
  options: DatabaseOptions,
  event: NewAuditEvent,
): Promise<AuditEvent> {
  const actor = requireNonEmpty(event.actor, "actor");
  const eventType = requireNonEmpty(event.eventType, "eventType");
  const payload = event.payload === undefined ? {} : asJsonObject(event.payload);

  return withPool(options, async (pool) => {
    const result = await pool.query<AuditEventRow>(
      `INSERT INTO audit_events (
         tenant_id, run_id, at, actor, event_type, capability, tier, payload, evidence_uri
       )
       VALUES (
         COALESCE($1, 'basileia'),
         $2,
         COALESCE($3, now()),
         $4,
         $5,
         $6,
         $7,
         $8::jsonb,
         $9
       )
       RETURNING event_id, tenant_id, run_id, at, actor, event_type, capability, tier, payload, evidence_uri`,
      [
        event.tenantId ?? null,
        event.runId ?? null,
        event.at ?? null,
        actor,
        eventType,
        event.capability ?? null,
        event.tier ?? null,
        JSON.stringify(payload),
        event.evidenceUri ?? null,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("insertAuditEvent did not return a persisted row.");
    }
    return toAuditEvent(row);
  });
}
