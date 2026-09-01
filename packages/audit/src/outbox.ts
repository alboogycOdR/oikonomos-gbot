/**
 * Delivery hardening for audit events bound to a remote/secondary sink
 * (future dashboard push, Telegram evidence, ...) — ported design from Grok
 * Bot's `action-audit-service.ts` (docs/STUDY-grok-bot-018.md §Tier 2).
 *
 * The LOCAL append-only write path (`recordAuditEvent` in `./index.js`) is
 * unaffected by anything in this module and remains the single source of
 * truth for `audit_events` (WBS OIK-013) — this module only concerns
 * itself with best-effort forwarding of already-durable events to a
 * secondary sink, and durably tracking which of them still need sending.
 *
 * "Persistent" here means: undelivered events are never lost to an
 * in-process failure of the *sink* — a failed `deliver()` call retains the
 * batch (see {@link AuditOutbox.flush}) for redelivery on the next flush,
 * across calls, and the caller is expected to persist the pending batch
 * itself (e.g. by re-reading `getAuditEventsForRun`/a delivery-cursor
 * audit event from `audit_events`) if it needs to survive a process
 * restart — no second writable store is introduced here, in keeping with
 * `audit_events` remaining the one source of truth.
 */

import type { AuditEvent } from "@oikonomos/db";

/**
 * A remote/secondary sink audit events are forwarded to. Implementations
 * MUST throw {@link RetryAfterError} (rather than a generic error) when
 * the failure is a rate limit that specifies a retry delay, so
 * {@link AuditOutbox.flush} can honour it.
 */
export interface AuditSink {
  deliver(events: readonly AuditEvent[]): Promise<void>;
}

/**
 * Thrown by an {@link AuditSink} to signal a rate-limit response that
 * carried a `Retry-After` (or equivalent) delay. `retryAfterMs` must be a
 * non-negative number of milliseconds to wait before the next attempt.
 */
export class RetryAfterError extends Error {
  public override readonly name = "RetryAfterError";
  public readonly retryAfterMs: number;

  public constructor(retryAfterMs: number, cause?: unknown) {
    super(`audit sink requested retry after ${retryAfterMs}ms`);
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new Error("retryAfterMs must be a non-negative finite number.");
    }
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
  }
}

/** Injectable clock so backoff delays are deterministic under test. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Emitted whenever the outbox drops its oldest-queued events to stay under
 * its cap — WBS/study requirement: cap overflow is NEVER silent. Callers
 * are expected to turn this into an audit event of its own (e.g. via
 * `recordAuditEvent` with `eventType: "audit.outbox.dropped"`) so the loss
 * itself is durably recorded.
 */
export interface DroppedBatch {
  readonly droppedCount: number;
  readonly at: Date;
}

export interface AuditOutboxOptions {
  readonly sink: AuditSink;
  /** Maximum number of undelivered events retained in memory at once. */
  readonly cap: number;
  readonly clock?: Clock;
  /** Called synchronously whenever oldest events are dropped for cap overflow. */
  readonly onDropped?: (batch: DroppedBatch) => void;
}

export interface FlushOptions {
  /** Maximum delivery attempts for this flush, retrying on RetryAfterError. Default 1 (no retry). */
  readonly maxAttempts?: number;
}

export interface FlushResult {
  readonly delivered: number;
  readonly attempts: number;
}

/**
 * A capped, in-memory queue of not-yet-delivered {@link AuditEvent}s with
 * Retry-After-aware backoff on delivery.
 */
export class AuditOutbox {
  private queue: AuditEvent[] = [];
  private droppedTotal = 0;
  private readonly sink: AuditSink;
  private readonly cap: number;
  private readonly clock: Clock;
  private readonly onDropped: ((batch: DroppedBatch) => void) | undefined;

  public constructor(options: AuditOutboxOptions) {
    if (!Number.isInteger(options.cap) || options.cap <= 0) {
      throw new Error("AuditOutbox cap must be a positive integer.");
    }
    this.sink = options.sink;
    this.cap = options.cap;
    this.clock = options.clock ?? systemClock;
    this.onDropped = options.onDropped;
  }

  /** Events currently queued for delivery, oldest first. Never mutated by callers. */
  public get pending(): readonly AuditEvent[] {
    return this.queue;
  }

  /** Running total of events dropped for cap overflow since construction. */
  public get totalDropped(): number {
    return this.droppedTotal;
  }

  /**
   * Enqueues an already-durably-written event for forwarding. If the queue
   * would exceed `cap`, the oldest events are dropped first — never the
   * newest — and {@link AuditOutboxOptions.onDropped} fires exactly once
   * per overflowing enqueue with the exact count dropped. Loss is never
   * silent: a caller that omits `onDropped` still observes it via
   * {@link totalDropped}.
   */
  public enqueue(event: AuditEvent): void {
    this.queue.push(event);
    if (this.queue.length > this.cap) {
      const overflow = this.queue.length - this.cap;
      const droppedEvents = this.queue.splice(0, overflow);
      this.droppedTotal += droppedEvents.length;
      this.onDropped?.({ droppedCount: droppedEvents.length, at: new Date(this.clock.now()) });
    }
  }

  /**
   * Attempts to deliver all pending events, in enqueue order, as a single
   * batch to the sink.
   *
   * - On success: the delivered events are removed from the queue and the
   *   result reports how many were delivered.
   * - On a plain sink failure: the queue is left untouched (events are
   *   retained, in order) and the error propagates — call `flush()` again
   *   later (e.g. after the sink recovers) to redeliver the same batch.
   * - On {@link RetryAfterError}: the requested delay is awaited via the
   *   injected {@link Clock} before either retrying (if attempts remain
   *   under `maxAttempts`) or propagating the error with the queue still
   *   intact.
   *
   * An empty queue is a no-op that never calls the sink.
   */
  public async flush(options?: FlushOptions): Promise<FlushResult> {
    const maxAttempts = options?.maxAttempts ?? 1;
    if (maxAttempts < 1) {
      throw new Error("maxAttempts must be at least 1.");
    }
    if (this.queue.length === 0) {
      return { delivered: 0, attempts: 0 };
    }

    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        // Snapshot so a concurrent enqueue() during an in-flight deliver()
        // cannot be silently swept away by the post-success splice below.
        const batch = this.queue;
        await this.sink.deliver(batch);
        this.queue = this.queue.slice(batch.length);
        return { delivered: batch.length, attempts };
      } catch (cause) {
        if (cause instanceof RetryAfterError && attempts < maxAttempts) {
          await this.clock.sleep(cause.retryAfterMs);
          continue;
        }
        throw cause;
      }
    }
  }
}
