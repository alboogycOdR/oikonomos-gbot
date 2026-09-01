/**
 * Exhaustive-over-union audit line formatter — ported design from Grok
 * Bot's `localAuditJsonlLine` (docs/STUDY-grok-bot-018.md §Tier 2): one
 * function maps every known audit action kind to its serialized JSONL
 * line, and the switch is written so that adding a new kind to
 * {@link AUDIT_ACTION_KINDS} without adding a matching `case` is a
 * TypeScript COMPILE error (via the `assertNever` fallthrough), not a
 * silent runtime gap.
 *
 * Redaction is never reimplemented here (N4 / TASK-059's rule): every
 * line's payload passes through `./redact.js`'s `redactPayload`, the sole
 * redaction implementation in this package.
 */

import type { AuditEvent } from "@oikonomos/db";

import { redactPayload } from "./redact.js";

/**
 * Every audit action kind this formatter knows how to render. This is
 * intentionally narrower than `AuditEvent.eventType` (a plain `string` at
 * the `@oikonomos/db` layer, since new event types are added over time) —
 * {@link toFormattableAuditEvent} is the runtime bridge that validates an
 * arbitrary `AuditEvent` against this closed set before formatting.
 */
export const AUDIT_ACTION_KINDS = [
  "policy.decision",
  "audit.outbox.dropped",
  "audit.outbox.delivered",
] as const;

export type AuditActionKind = (typeof AUDIT_ACTION_KINDS)[number];

/** An {@link AuditEvent} whose `eventType` has been validated to be a known {@link AuditActionKind}. */
export interface FormattableAuditEvent extends Omit<AuditEvent, "eventType"> {
  readonly eventType: AuditActionKind;
}

/** Thrown by {@link toFormattableAuditEvent} for an `eventType` outside the closed {@link AUDIT_ACTION_KINDS} set. */
export class UnknownAuditActionKindError extends Error {
  public override readonly name = "UnknownAuditActionKindError";
  public readonly eventType: string;

  public constructor(eventType: string) {
    super(`no audit line format is registered for eventType=${eventType}`);
    this.eventType = eventType;
  }
}

function isAuditActionKind(eventType: string): eventType is AuditActionKind {
  return (AUDIT_ACTION_KINDS as readonly string[]).includes(eventType);
}

/**
 * Validates that `event.eventType` is one of the closed {@link
 * AUDIT_ACTION_KINDS}, narrowing the type so {@link formatAuditLine}'s
 * switch can be exhaustive at compile time. Throws
 * {@link UnknownAuditActionKindError} for anything else — a run-time gap
 * (an eventType nobody taught this formatter about yet) fails loudly
 * rather than silently dropping the line.
 */
export function toFormattableAuditEvent(event: AuditEvent): FormattableAuditEvent {
  if (!isAuditActionKind(event.eventType)) {
    throw new UnknownAuditActionKindError(event.eventType);
  }
  return event as FormattableAuditEvent;
}

/**
 * Exhaustiveness helper: a value that reaches here must be typed `never`.
 * If {@link AUDIT_ACTION_KINDS} grows a member without a matching `case`
 * in {@link formatAuditLine}, `event.eventType` in the `default` branch
 * stops being `never` and this call fails to typecheck.
 */
function assertNever(x: never): never {
  throw new Error(`Unhandled audit action kind: ${JSON.stringify(x)}`);
}

function baseFields(event: FormattableAuditEvent): Record<string, unknown> {
  return {
    at: event.at.toISOString(),
    eventType: event.eventType,
    eventId: event.eventId,
    tenantId: event.tenantId,
    runId: event.runId,
    actor: event.actor,
    capability: event.capability,
    tier: event.tier,
    evidenceUri: event.evidenceUri,
  };
}

/**
 * Formats a single audit event as one JSONL line. Every branch redacts
 * `payload` via {@link redactPayload} before serializing — there is no
 * path through this function that emits an unredacted payload.
 */
export function formatAuditLine(event: FormattableAuditEvent): string {
  switch (event.eventType) {
    case "policy.decision": {
      const line = { ...baseFields(event), payload: redactPayload(event.payload) };
      return JSON.stringify(line);
    }
    case "audit.outbox.dropped": {
      const line = { ...baseFields(event), payload: redactPayload(event.payload) };
      return JSON.stringify(line);
    }
    case "audit.outbox.delivered": {
      const line = { ...baseFields(event), payload: redactPayload(event.payload) };
      return JSON.stringify(line);
    }
    default:
      return assertNever(event.eventType);
  }
}

/** Convenience: validate-then-format a raw {@link AuditEvent} in one call. */
export function formatAuditEventLine(event: AuditEvent): string {
  return formatAuditLine(toFormattableAuditEvent(event));
}
