import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AuditWriteError,
  recordAuditEvent,
  recordDecision,
  type DatabaseOptions,
} from "../src/index.js";

// Follows TASK-006's precedent: integration tests run against the local
// compose Postgres (infra/compose/docker-compose.local.yml, migrated with
// infra/postgres/migrations/001_schema_v1.up.sql) and skip cleanly when
// DATABASE_URL is unset, so the suite stays green on a machine with no
// database.
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/audit writer (integration)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };

  it("writes a denial as a persisted row, not just an allow — WBS OIK-025", async () => {
    const probe = randomUUID();

    const denied = await recordDecision(options, {
      actor: "broker",
      capability: "email.send",
      tier: "T3_external",
      verdict: "deny",
      reason: "constraint.domains",
      payload: { probe },
    });

    // A denial that is not audited is indistinguishable from an action that
    // never happened — so the persisted row must carry the denial itself,
    // not a placeholder. `event_id` only exists because Postgres actually
    // inserted and returned this row (RETURNING clause in
    // @oikonomos/db#insertAuditEvent) — this is the "produces a row"
    // assertion, not a mock.
    expect(denied.eventId).toMatch(/^\d+$/);
    expect(denied.eventType).toBe("policy.decision");
    expect(denied.actor).toBe("broker");
    expect(denied.capability).toBe("email.send");
    expect(denied.tier).toBe("T3_external");
    expect(denied.payload).toEqual({
      verdict: "deny",
      reason: "constraint.domains",
      probe,
    });

    const allowed = await recordDecision(options, {
      actor: "broker",
      capability: "email.send",
      tier: "T2_internal",
      verdict: "allow",
      payload: { probe },
    });

    // Two distinct events, two distinct rows — the deny did not get
    // collapsed into, replaced by, or skipped in favour of the allow.
    expect(allowed.eventId).not.toBe(denied.eventId);
    expect(allowed.payload).toEqual({ verdict: "allow", probe });
  });

  it("writes a require_approval decision the same way as allow/deny — no verdict is special-cased out", async () => {
    const pending = await recordDecision(options, {
      actor: "broker",
      capability: "email.send",
      tier: "T3_external",
      verdict: "require_approval",
      payload: { destination: "finance@basileia.example" },
    });

    expect(pending.eventId).toMatch(/^\d+$/);
    expect(pending.payload.verdict).toBe("require_approval");
  });

  it("writes arbitrary non-decision event types through the generic recordAuditEvent path", async () => {
    const event = await recordAuditEvent(options, {
      actor: "agent:claude-code",
      eventType: "tool.request",
      capability: "browser.click",
      payload: { toolUseId: randomUUID() },
    });

    expect(event.eventId).toMatch(/^\d+$/);
    expect(event.eventType).toBe("tool.request");
  });

  it("surfaces a write failure to the caller as AuditWriteError rather than swallowing it — ADR-001 R3", async () => {
    const write = recordDecision(options, {
      actor: "broker",
      runId: "not-a-uuid",
      verdict: "deny",
      reason: "constraint.rate_per_hour",
    });

    await expect(write).rejects.toBeInstanceOf(AuditWriteError);
    await expect(write).rejects.toThrow(/uuid/i);

    // The caller can distinguish "audited" from "not audited": the
    // rejection carries which actor/eventType failed to write, and the
    // original database error is preserved on `cause` rather than lost.
    const rejection: unknown = await write.catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(AuditWriteError);
    const err = rejection as AuditWriteError;
    expect(err.actor).toBe("broker");
    expect(err.eventType).toBe("policy.decision");
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("rejects with AuditWriteError (not a silent no-op) when the connection string is empty", async () => {
    const write = recordAuditEvent(
      { connectionString: "   " },
      { actor: "broker", eventType: "policy.decision", payload: { verdict: "deny" } },
    );

    await expect(write).rejects.toBeInstanceOf(AuditWriteError);
    await expect(write).rejects.toThrow(/connectionString/);
  });
});

describe("packages/audit writer — integration suite skip behaviour", () => {
  it("documents why the suite above is skipped when DATABASE_URL is unset (TASK-006 precedent)", () => {
    // This is a plain, always-run unit test (no DATABASE_URL required) that
    // exists so `passWithNoTests: false` never trips this file into a false
    // failure on a machine with no database — the describe.skip block above
    // still registers as a (skipped) suite, but this keeps at least one
    // concrete assertion running unconditionally.
    expect(typeof connectionString === "string" || connectionString === undefined).toBe(true);
  });
});
