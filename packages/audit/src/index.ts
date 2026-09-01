import {
  insertAuditEvent,
  type AuditEvent,
  type DatabaseOptions,
  type NewAuditEvent,
  type RiskTier,
} from "@oikonomos/db";

import { redactPayload } from "./redact.js";

export type { AuditEvent, DatabaseOptions, NewAuditEvent, RiskTier } from "@oikonomos/db";

/**
 * Redacts secret-shaped values before they cross a trusted boundary. This is
 * the single public N4 redaction implementation; presentation layers must
 * reuse it rather than maintaining their own pattern set.
 */
export { redactPayload } from "./redact.js";

/**
 * Capped persistent outbox for audit events bound to a remote/secondary
 * sink (future dashboard push, Telegram evidence) — retains undelivered
 * events across sink failures, drops the oldest ONLY with an explicit
 * dropped-count marker (never silently), and backs off on `Retry-After`
 * via an injected {@link Clock} (TASK-077). Local append-path behaviour
 * above (`recordAuditEvent`/`recordDecision`) is unchanged and unaffected.
 */
export {
  AuditOutbox,
  RetryAfterError,
  systemClock,
  type AuditSink,
  type Clock,
  type DroppedBatch,
  type AuditOutboxOptions,
  type FlushOptions,
  type FlushResult,
} from "./outbox.js";

/**
 * Exhaustive-union audit line formatter (TASK-077) — mapping every audit
 * action kind to its serialized line, written so a new kind fails
 * typecheck until its format branch exists. Passes every field through
 * {@link redactPayload}; never a second redaction implementation (N4).
 */
export {
  AUDIT_ACTION_KINDS,
  UnknownAuditActionKindError,
  toFormattableAuditEvent,
  formatAuditLine,
  formatAuditEventLine,
  type AuditActionKind,
  type FormattableAuditEvent,
} from "./format.js";

/**
 * Thrown when a write to `audit_events` fails for any reason. The original
 * failure is preserved on `cause`.
 *
 * A rejected `recordAuditEvent`/`recordDecision` promise means the event was
 * NOT durably recorded — callers MUST treat this as "not audited" and fail
 * the action closed (ADR-001 R3) rather than proceeding as if the write had
 * succeeded. Never catch this and continue.
 */
export class AuditWriteError extends Error {
  public override readonly name = "AuditWriteError";
  public readonly actor: string;
  public readonly eventType: string;

  public constructor(actor: string, eventType: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`audit write failed for actor=${actor} eventType=${eventType}: ${causeMessage}`);
    this.actor = actor;
    this.eventType = eventType;
    this.cause = cause;
  }
}

/**
 * Append-only write to `audit_events`.
 *
 * This module intentionally exposes no update, delete, or otherwise
 * mutating operation on `audit_events` — see
 * `packages/audit/test/persistence-surface.test.ts`. Combined with the
 * `audit_no_update` / `audit_no_delete` `DO INSTEAD NOTHING` rules enforced
 * at the database layer (`infra/postgres/migrations/001_schema_v1.up.sql`,
 * TASK-002), there is no path — through this package or the database — by
 * which a written event can later be changed or removed (WBS OIK-013).
 *
 * Failures are never swallowed: a caught error from the underlying insert
 * is re-thrown as {@link AuditWriteError} so the caller can distinguish
 * "audited" from "not audited" and fail the action closed (ADR-001 R3).
 *
 * Before the write, `event.payload` is passed through {@link redactPayload}
 * (WBS OIK-026: "Secret patterns stripped pre-write") — this is the sole
 * write path into `audit_events` (see the module doc above), so every
 * caller, including {@link recordDecision}, gets redaction for free and
 * cannot bypass it by calling `insertAuditEvent` directly, since that
 * function is not re-exported from this package.
 */
export async function recordAuditEvent(
  options: DatabaseOptions,
  event: NewAuditEvent,
): Promise<AuditEvent> {
  const redactedEvent: NewAuditEvent = {
    ...event,
    payload: redactPayload(event.payload),
  };
  try {
    return await insertAuditEvent(options, redactedEvent);
  } catch (cause) {
    throw new AuditWriteError(event.actor, event.eventType, cause);
  }
}

/**
 * Every verdict a policy/broker decision can reach (Synthesis Spec §5.2
 * `PolicyDecision["verdict"]`).
 */
export type DecisionVerdict = "allow" | "require_approval" | "deny";

export interface DecisionAuditEvent {
  tenantId?: string;
  runId?: string | null;
  at?: Date;
  actor: string;
  capability?: string | null;
  tier?: RiskTier | null;
  verdict: DecisionVerdict;
  /** Required context for `deny` — WBS OIK-025 "every decision written incl. denials". */
  reason?: string;
  evidenceUri?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Builds the `NewAuditEvent` a decision maps to, without performing any I/O.
 * Exported separately so the mapping (in particular: does a denial actually
 * carry its verdict and reason into the payload?) is unit-testable without a
 * database.
 */
export function toDecisionAuditEvent(event: DecisionAuditEvent): NewAuditEvent {
  const payload: Record<string, unknown> = {
    ...event.payload,
    verdict: event.verdict,
  };
  if (event.reason !== undefined) {
    payload.reason = event.reason;
  }

  return {
    tenantId: event.tenantId,
    runId: event.runId,
    at: event.at,
    actor: event.actor,
    eventType: "policy.decision",
    capability: event.capability,
    tier: event.tier,
    payload,
    evidenceUri: event.evidenceUri,
  };
}

/**
 * Records a policy/broker decision as an audit event — `allow`,
 * `require_approval`, and `deny` alike. Every decision is written,
 * including denials (WBS OIK-025): a denial that is never audited is
 * indistinguishable from an action that never happened.
 */
export async function recordDecision(
  options: DatabaseOptions,
  event: DecisionAuditEvent,
): Promise<AuditEvent> {
  return recordAuditEvent(options, toDecisionAuditEvent(event));
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("AuditWriteError", () => {
    it("carries the actor, event type, and original cause of a failed write", () => {
      const cause = new Error("connection refused");
      const err = new AuditWriteError("broker", "policy.decision", cause);

      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("AuditWriteError");
      expect(err.actor).toBe("broker");
      expect(err.eventType).toBe("policy.decision");
      expect(err.cause).toBe(cause);
      expect(err.message).toContain("broker");
      expect(err.message).toContain("policy.decision");
      expect(err.message).toContain("connection refused");
    });

    it("stringifies a non-Error cause rather than throwing while formatting the message", () => {
      const err = new AuditWriteError("broker", "policy.decision", "raw string failure");
      expect(err.message).toContain("raw string failure");
      expect(err.cause).toBe("raw string failure");
    });
  });

  describe("toDecisionAuditEvent", () => {
    it("maps an allow decision to a policy.decision event with no reason key", () => {
      const mapped = toDecisionAuditEvent({
        actor: "broker",
        capability: "email.send",
        tier: "T2_internal",
        verdict: "allow",
      });

      expect(mapped.eventType).toBe("policy.decision");
      expect(mapped.actor).toBe("broker");
      expect(mapped.capability).toBe("email.send");
      expect(mapped.tier).toBe("T2_internal");
      expect(mapped.payload).toEqual({ verdict: "allow" });
    });

    it("maps a deny decision with its reason into the payload — denials are not special-cased away", () => {
      const mapped = toDecisionAuditEvent({
        actor: "broker",
        capability: "email.send",
        tier: "T3_external",
        verdict: "deny",
        reason: "capability.unregistered",
      });

      expect(mapped.eventType).toBe("policy.decision");
      expect(mapped.payload).toEqual({
        verdict: "deny",
        reason: "capability.unregistered",
      });
    });

    it("merges caller-supplied payload fields alongside verdict and reason", () => {
      const mapped = toDecisionAuditEvent({
        actor: "broker",
        verdict: "require_approval",
        payload: { destination: "finance@basileia.example" },
      });

      expect(mapped.payload).toEqual({
        destination: "finance@basileia.example",
        verdict: "require_approval",
      });
    });

    it("passes runId, at, tenantId, and evidenceUri through unchanged", () => {
      const at = new Date("2026-01-01T00:00:00.000Z");
      const mapped = toDecisionAuditEvent({
        tenantId: "basileia",
        runId: "11111111-1111-1111-1111-111111111111",
        at,
        actor: "broker",
        verdict: "deny",
        reason: "constraint.rate_per_hour",
        evidenceUri: "evidence://run/step-3",
      });

      expect(mapped.tenantId).toBe("basileia");
      expect(mapped.runId).toBe("11111111-1111-1111-1111-111111111111");
      expect(mapped.at).toBe(at);
      expect(mapped.evidenceUri).toBe("evidence://run/step-3");
    });
  });
}
