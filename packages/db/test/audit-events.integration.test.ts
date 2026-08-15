import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultPoolConfig,
  insertAuditEvent,
  type DatabaseOptions,
} from "../src/index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("insertAuditEvent", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists migration-001 columns and returns the stored row, not the input", async () => {
    const actor = "broker";
    const eventType = "policy.decision";
    const payload = {
      decision: "deny",
      reason: "unregistered",
      probe: randomUUID(),
    };

    const persisted = await insertAuditEvent(options, {
      actor,
      eventType,
      capability: "email.send",
      tier: "T3_external",
      payload,
      evidenceUri: "evidence://task-020/audit",
    });

    expect(persisted.eventId).toMatch(/^\d+$/);
    expect(persisted.tenantId).toBe("basileia");
    expect(persisted.runId).toBeNull();
    expect(persisted.at).toBeInstanceOf(Date);
    expect(persisted.actor).toBe(actor);
    expect(persisted.eventType).toBe(eventType);
    expect(persisted.capability).toBe("email.send");
    expect(persisted.tier).toBe("T3_external");
    expect(persisted.payload).toEqual(payload);
    expect(persisted.evidenceUri).toBe("evidence://task-020/audit");

    const stored = await pool.query(
      `SELECT event_id, tenant_id, run_id, at, actor, event_type, capability, tier, payload, evidence_uri
       FROM audit_events
       WHERE event_id = $1`,
      [persisted.eventId],
    );

    expect(stored.rows).toHaveLength(1);
    expect(String(stored.rows[0].event_id)).toBe(persisted.eventId);
    expect(stored.rows[0].tenant_id).toBe(persisted.tenantId);
    expect(stored.rows[0].run_id).toBeNull();
    expect(stored.rows[0].at).toEqual(persisted.at);
    expect(stored.rows[0].actor).toBe(persisted.actor);
    expect(stored.rows[0].event_type).toBe(persisted.eventType);
    expect(stored.rows[0].capability).toBe(persisted.capability);
    expect(stored.rows[0].tier).toBe(persisted.tier);
    expect(stored.rows[0].payload).toEqual(persisted.payload);
    expect(stored.rows[0].evidence_uri).toBe(persisted.evidenceUri);
  });

  it("propagates a write failure as a rejected promise", async () => {
    const write = insertAuditEvent(options, {
      actor: "broker",
      eventType: "policy.decision",
      runId: "not-a-uuid",
    });

    await expect(write).rejects.toThrow(/uuid/i);
    await expect(write).rejects.toBeInstanceOf(Error);
  });
});
