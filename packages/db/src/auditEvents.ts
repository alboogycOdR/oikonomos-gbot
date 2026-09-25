import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";
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

export interface WorkforceEventCount {
  /** The durable category that crossed (or contributes to) a workforce threshold. */
  category: "group.cap_reached" | "role_message.depth_capped" | "role_message.duplicate" | "role_message.delivery_failed" | "group.message_count";
  /** A group thread id for group categories, or the originating role id for handoffs. */
  sourceId: string;
  count: number;
}

export interface ProjectFanoutAdmissionInput {
  tenantId: string;
  runId: string;
  actor: string;
  projectId: string;
  taskId: string;
  ownerRoleId: string;
  rosterSize: number;
  /**
   * Runs while the per-run advisory lock is held, before an admitted
   * assignment event is persisted. This keeps the audit trail's assignment
   * event after the durable owner mutation without reopening the cap race.
   */
  onAdmitted?: () => Promise<void>;
}

export interface ProjectFanoutAdmission {
  admitted: boolean;
  assignmentCount: number;
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

/**
 * Returns the most recent event of a type, optionally scoped to a tenant.
 * This is deliberately a read-only liveness primitive: consumers can judge
 * when a recurring control last produced durable evidence without inferring
 * it from process state or a queue schedule.
 */
export async function getLatestAuditEvent(
  options: DatabaseOptions,
  eventType: string,
  tenantId?: string,
  actor?: string,
): Promise<AuditEvent | null> {
  const normalizedEventType = requireNonEmpty(eventType, "eventType");
  const normalizedTenantId = tenantId === undefined ? undefined : requireNonEmpty(tenantId, "tenantId");
  const normalizedActor = actor === undefined ? undefined : requireNonEmpty(actor, "actor");

  return withPool(options, async (pool) => {
    const result = await pool.query<AuditEventRow>(
      `SELECT event_id, tenant_id, run_id, at, actor, event_type, capability, tier, payload, evidence_uri
       FROM audit_events
       WHERE event_type = $1
         AND ($2::text IS NULL OR tenant_id = $2)
         AND ($3::text IS NULL OR actor = $3)
       ORDER BY at DESC, event_id DESC
       LIMIT 1`,
      [normalizedEventType, normalizedTenantId ?? null, normalizedActor ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAuditEvent(row);
  });
}

/**
 * Counts the bounded, category-only signals used by the deterministic
 * workforce checker. Every arm is tenant-scoped in SQL: callers never need
 * to infer ownership from a cross-tenant transcript or audit stream.
 */
export async function getWorkforceEventCounts(
  options: DatabaseOptions,
  input: { tenantId: string; since: Date },
): Promise<WorkforceEventCount[]> {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  if (!(input.since instanceof Date) || Number.isNaN(input.since.getTime())) {
    throw new Error("since must be a valid Date.");
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<{ category: WorkforceEventCount["category"]; source_id: string; count: string }>(
      `SELECT event_type AS category,
              CASE WHEN event_type = 'group.cap_reached' THEN payload ->> 'threadId'
                   ELSE substring(actor FROM '^role:(.+)$') END AS source_id,
              count(*)::text AS count
         FROM audit_events
        WHERE tenant_id = $1
          AND at >= $2
          AND event_type IN ('group.cap_reached', 'role_message.depth_capped', 'role_message.duplicate')
        GROUP BY event_type, source_id
       UNION ALL
       SELECT 'role_message.delivery_failed' AS category,
              from_role_id AS source_id,
              count(*)::text AS count
         FROM role_messages
        WHERE tenant_id = $1
          AND delivery_failed_at >= $2
        GROUP BY from_role_id
       UNION ALL
       SELECT 'group.message_count' AS category,
              threads.id::text AS source_id,
              count(messages.id)::text AS count
         FROM threads
         LEFT JOIN messages ON messages.thread_id = threads.id AND messages.created_at >= $2
        WHERE threads.role_id IS NULL
          AND EXISTS (
            SELECT 1
              FROM thread_members
              JOIN roles ON roles.role_id = thread_members.role_id
             WHERE thread_members.thread_id = threads.id
               AND roles.tenant_id = $1
          )
        GROUP BY threads.id`,
      [tenantId, input.since],
    );
    return result.rows
      // Old group-cap events predate TASK-363's persisted thread id and are
      // intentionally not guessed into a room.
      .filter((row) => row.source_id.trim().length > 0)
      .map((row) => ({ category: row.category, sourceId: row.source_id, count: Number(row.count) }));
  });
}

/**
 * Atomically reserves one project assignment handoff for a manager run.
 * The transaction advisory-locks the run before counting its persisted
 * assignment events, so independent MCP processes cannot over-admit.
 */
export async function admitProjectFanout(
  options: DatabaseOptions,
  input: ProjectFanoutAdmissionInput,
): Promise<ProjectFanoutAdmission> {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const runId = requireUuid(input.runId, "runId");
  const actor = requireNonEmpty(input.actor, "actor");
  const projectId = requireUuid(input.projectId, "projectId");
  const taskId = requireUuid(input.taskId, "taskId");
  const ownerRoleId = requireNonEmpty(input.ownerRoleId, "ownerRoleId");
  if (!Number.isInteger(input.rosterSize) || input.rosterSize < 0) {
    throw new Error("rosterSize must be a non-negative integer.");
  }

  return withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runId]);
      const counted = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM audit_events WHERE run_id = $1 AND event_type = 'project.task_assigned'",
        [runId],
      );
      const assignmentCount = Number(counted.rows[0]?.count ?? 0);
      const admitted = assignmentCount < input.rosterSize;
      if (admitted) {
        await input.onAdmitted?.();
      }
      await client.query(
        `INSERT INTO audit_events (tenant_id, run_id, actor, event_type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          tenantId,
          runId,
          actor,
          admitted ? "project.task_assigned" : "project.fanout_capped",
          JSON.stringify({
            project_id: projectId,
            task_id: taskId,
            ...(admitted ? { owner_role_id: ownerRoleId } : {}),
            roster_size: input.rosterSize,
          }),
        ],
      );
      await client.query("COMMIT");
      return { admitted, assignmentCount };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    } finally {
      client.release();
    }
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

    it("rejects an empty event type before opening a pool", async () => {
      await expect(
        getLatestAuditEvent({ connectionString: "postgres://x" }, "  "),
      ).rejects.toThrow(/eventType/);
    });
  });
}
