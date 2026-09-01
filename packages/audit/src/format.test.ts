import { describe, expect, it } from "vitest";

import type { AuditEvent } from "@oikonomos/db";

import { REDACTED_MARKER } from "./redact.js";
import {
  AUDIT_ACTION_KINDS,
  UnknownAuditActionKindError,
  formatAuditEventLine,
  formatAuditLine,
  toFormattableAuditEvent,
} from "./format.js";

function fixtureEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    eventId: overrides.eventId ?? "11111111-1111-1111-1111-111111111111",
    tenantId: overrides.tenantId ?? "basileia",
    runId: overrides.runId ?? null,
    at: overrides.at ?? new Date("2026-01-01T00:00:00.000Z"),
    actor: overrides.actor ?? "broker",
    eventType: overrides.eventType ?? "policy.decision",
    capability: overrides.capability ?? null,
    tier: overrides.tier ?? null,
    payload: overrides.payload ?? { verdict: "allow" },
    evidenceUri: overrides.evidenceUri ?? null,
  };
}

describe("toFormattableAuditEvent", () => {
  it("passes through every known audit action kind", () => {
    for (const kind of AUDIT_ACTION_KINDS) {
      const event = fixtureEvent({ eventType: kind });
      expect(() => toFormattableAuditEvent(event)).not.toThrow();
    }
  });

  it("throws UnknownAuditActionKindError for an eventType outside the closed set", () => {
    const event = fixtureEvent({ eventType: "some.unregistered.kind" });
    expect(() => toFormattableAuditEvent(event)).toThrow(UnknownAuditActionKindError);
  });
});

describe("formatAuditLine — exhaustive over AUDIT_ACTION_KINDS", () => {
  it("formats every known kind as valid JSON carrying the base fields", () => {
    for (const kind of AUDIT_ACTION_KINDS) {
      const event = fixtureEvent({ eventType: kind, payload: { note: "fine" } });
      const line = formatAuditLine(toFormattableAuditEvent(event));
      const parsed = JSON.parse(line) as Record<string, unknown>;

      expect(parsed.eventType).toBe(kind);
      expect(parsed.at).toBe("2026-01-01T00:00:00.000Z");
      expect(parsed.actor).toBe("broker");
      expect(parsed.payload).toEqual({ note: "fine" });
    }
  });

  it("formatAuditEventLine validates-then-formats a raw AuditEvent in one call", () => {
    const event = fixtureEvent({ eventType: "audit.outbox.dropped", payload: { droppedCount: 3 } });
    const line = formatAuditEventLine(event);
    expect(JSON.parse(line)).toMatchObject({ eventType: "audit.outbox.dropped", payload: { droppedCount: 3 } });
  });

  it("formatAuditEventLine throws for an unknown kind rather than silently formatting garbage", () => {
    const event = fixtureEvent({ eventType: "not.a.real.kind" });
    expect(() => formatAuditEventLine(event)).toThrow(UnknownAuditActionKindError);
  });
});

describe("formatAuditLine — redaction (N4: reuses redact.ts, never reimplements)", () => {
  const fakeApiKey = ["sk", "PLACEHOLDER_FAKE_NOT_A_REAL_SECRET_KEY"].join("-");

  it("redacts a secret-shaped payload value before serializing, for every action kind", () => {
    for (const kind of AUDIT_ACTION_KINDS) {
      const event = fixtureEvent({ eventType: kind, payload: { apiKey: fakeApiKey, note: "fine" } });
      const line = formatAuditLine(toFormattableAuditEvent(event));
      const parsed = JSON.parse(line) as { payload: Record<string, unknown> };

      expect(parsed.payload.apiKey).toBe(REDACTED_MARKER);
      expect(parsed.payload.note).toBe("fine");
      expect(line).not.toContain(fakeApiKey);
    }
  });

  it("passes an undefined payload through unchanged (no manufactured object)", () => {
    const event: AuditEvent = { ...fixtureEvent(), payload: undefined as unknown as Record<string, unknown> };
    const line = formatAuditLine(toFormattableAuditEvent(event));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.payload).toBeUndefined();
  });
});
