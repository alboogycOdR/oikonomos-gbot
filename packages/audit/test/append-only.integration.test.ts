import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

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
const truncateGuardUpMigration = new URL(
  "../../../infra/postgres/migrations/032_audit_truncate_guard.up.sql",
  import.meta.url,
);
const truncateGuardDownMigration = new URL(
  "../../../infra/postgres/migrations/032_audit_truncate_guard.down.sql",
  import.meta.url,
);

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

  it("refuses direct and cascading TRUNCATE statements without losing audit rows", async () => {
    const probe = randomUUID();
    const written = await recordAuditEvent(options, {
      actor: "test:append-only-truncate",
      eventType: "tool.request",
      payload: { probe },
    });

    await expect(client.query("TRUNCATE audit_events")).rejects.toMatchObject({ code: "55000" });
    // audit_events has a foreign key to runs.  PostgreSQL includes it in this
    // cascade, so this verifies the guard is invoked for cascaded truncation
    // too, before any table in the statement can be emptied.
    await expect(client.query("TRUNCATE runs CASCADE")).rejects.toMatchObject({ code: "55000" });

    const reread = await client.query("SELECT payload FROM audit_events WHERE event_id = $1::bigint", [
      written.eventId,
    ]);
    expect(reread.rowCount).toBe(1);
    expect(reread.rows[0].payload).toEqual({ probe });
  });

  it("proves the TRUNCATE guard is live and its migrations reverse cleanly", async () => {
    const probe = randomUUID();
    const written = await recordAuditEvent(options, {
      actor: "test:append-only-truncate-liveness",
      eventType: "tool.request",
      payload: { probe },
    });
    const [downMigration, upMigration] = await Promise.all([
      readFile(truncateGuardDownMigration, "utf8"),
      readFile(truncateGuardUpMigration, "utf8"),
    ]);

    await client.query("BEGIN");
    try {
      // The down/up/down/up cycle uses the migrations themselves, proving
      // their IF EXISTS / OR REPLACE structure is reversible and repeatable.
      await client.query(downMigration);
      await client.query(upMigration);
      await client.query(downMigration);
      await client.query(upMigration);

      // A liveness test must show that an inert guard changes the outcome.
      // Drop only the trigger (not its function), then prove TRUNCATE works.
      await client.query("DROP TRIGGER audit_events_reject_truncate ON audit_events");
      await expect(client.query("TRUNCATE audit_events")).resolves.toBeDefined();
    } finally {
      // Restore both the written event and the guard for every other test.
      await client.query("ROLLBACK");
    }

    const reread = await client.query("SELECT payload FROM audit_events WHERE event_id = $1::bigint", [
      written.eventId,
    ]);
    expect(reread.rowCount).toBe(1);
    expect(reread.rows[0].payload).toEqual({ probe });
  });
});

describe("packages/audit append-only property — integration suite skip behaviour", () => {
  it("documents why the suite above is skipped when DATABASE_URL is unset (TASK-006/TASK-011 precedent)", () => {
    expect(typeof connectionString === "string" || connectionString === undefined).toBe(true);
  });
});
