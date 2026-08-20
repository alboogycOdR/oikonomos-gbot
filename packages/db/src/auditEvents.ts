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

/**
 * Read-only by construction (OIK-013): `audit_events` carries `ON UPDATE
 * ... DO INSTEAD NOTHING` / `ON DELETE ... DO INSTEAD NOTHING` rules at
 * the schema level, and this module adds no UPDATE/DELETE statement on
 * top of that. Oldest-first so a run's trail reads chronologically.
 */
export async function getAuditEventsForRun(
  options: DatabaseOptions,
  runId: string,
): Promise<AuditEvent[]> {
  const normalizedRunId = requireUuid(runId, "runId");

  return withPool(options, async (pool) => {
    const result = await pool.query<AuditEventRow>(
      `SELECT event_id, tenant_id, run_id, at, actor, event_type, capability, tier, payload, evidence_uri
       FROM audit_events
       WHERE run_id = $1
       ORDER BY at ASC, event_id ASC`,
      [normalizedRunId],
    );
    return result.rows.map(toAuditEvent);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Validation-only: no live-DB assertions here. This module is imported
  // (transitively, via index.js) by every other test file in the package,
  // and `import.meta.vitest` blocks re-register whenever the module loads
  // — a live-DB test here would run once per importing file, concurrently,
  // against the same rows. The live-DB coverage for `getAuditEventsForRun`
  // lives in `runs.test.ts` (a dedicated, not-otherwise-imported file)
  // instead.
  describe("@oikonomos/db auditEvents — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        getAuditEventsForRun(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
    });

    it("rejects a non-UUID runId", async () => {
      await expect(
        getAuditEventsForRun({ connectionString: "postgres://x" }, "not-a-uuid"),
      ).rejects.toThrow(/UUID/);
    });
  });
}
