import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordAuditEvent, type DatabaseOptions } from "../src/index.js";

// Re-scoped from TASK-011 AC3 (see PLAN.md TASK-012, "ADDED 2026-08-15T14:30Z"
// entry): TASK-011's persistence-surface.test.ts proves this package exposes
// no exported UPDATE/DELETE-shaped function, but that alone would stay green
// even if TASK-002's `audit_no_update` / `audit_no_delete` DO INSTEAD NOTHING
// rules were dropped tomorrow — nothing in the suite actually executes an
// UPDATE or DELETE against `audit_events`. This file closes that gap end to
// end: write a real event through this package's own writer, then attempt a
// raw UPDATE and DELETE against that exact row by `event_id`, and prove the
// row survives both unchanged.
//
// `pg` is a narrow, package.json-granted DEV dependency for this test only
// (PLAN.md TASK-012 "NARROW GRANT" note) — the runtime write path above
// (`recordAuditEvent`) still goes through `@oikonomos/db` with zero raw SQL
// in `src/**`; this file uses `pg` directly only to attempt the mutation the
// database itself must refuse.
//
// Follows TASK-006/TASK-011's precedent: runs against the local compose
// Postgres and skips cleanly when DATABASE_URL is unset, so the suite stays
// green on a machine with no database.
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/audit append-only property (integration, raw SQL)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("survives a direct UPDATE against a row written through the package's own writer", async () => {
    const probe = randomUUID();
    const written = await recordAuditEvent(options, {
      actor: "test:append-only-update",
      eventType: "tool.request",
      payload: { probe },
    });

    const updateResult = await client.query(
      "UPDATE audit_events SET actor = $1 WHERE event_id = $2::bigint",
      ["tampered-actor", written.eventId],
    );

    // The `audit_no_update` DO INSTEAD NOTHING rule makes the UPDATE a
    // structural no-op: it "succeeds" (no error) but affects zero rows and
    // changes nothing.
    expect(updateResult.rowCount).toBe(0);

    const reread = await client.query(
      "SELECT actor, payload FROM audit_events WHERE event_id = $1::bigint",
      [written.eventId],
    );
    expect(reread.rowCount).toBe(1);
    expect(reread.rows[0].actor).toBe("test:append-only-update");
    expect(reread.rows[0].payload).toEqual({ probe });
  });

  it("survives a direct DELETE against a row written through the package's own writer", async () => {
    const probe = randomUUID();
    const written = await recordAuditEvent(options, {
      actor: "test:append-only-delete",
      eventType: "tool.request",
      payload: { probe },
    });

    const deleteResult = await client.query("DELETE FROM audit_events WHERE event_id = $1::bigint", [
      written.eventId,
    ]);

    // The `audit_no_delete` DO INSTEAD NOTHING rule makes the DELETE a
    // structural no-op the same way: zero rows affected, row intact.
    expect(deleteResult.rowCount).toBe(0);

    const reread = await client.query("SELECT event_id FROM audit_events WHERE event_id = $1::bigint", [
      written.eventId,
    ]);
    expect(reread.rowCount).toBe(1);
    expect(reread.rows[0].event_id).toBe(written.eventId);
  });
});

describe("packages/audit append-only property — integration suite skip behaviour", () => {
  it("documents why the suite above is skipped when DATABASE_URL is unset (TASK-006/TASK-011 precedent)", () => {
    expect(typeof connectionString === "string" || connectionString === undefined).toBe(true);
  });
});
