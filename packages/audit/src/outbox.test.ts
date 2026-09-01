import { describe, expect, it, vi } from "vitest";

import type { AuditEvent } from "@oikonomos/db";

import { AuditOutbox, RetryAfterError, type AuditSink, type Clock } from "./outbox.js";

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

function fakeClock(): Clock & { readonly sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    now: () => 0,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    sleeps,
  };
}

describe("AuditOutbox — enqueue / cap overflow", () => {
  it("retains events under the cap in enqueue order", () => {
    const sink: AuditSink = { deliver: vi.fn(async () => undefined) };
    const outbox = new AuditOutbox({ sink, cap: 3 });
    const e1 = fixtureEvent({ eventId: "1" });
    const e2 = fixtureEvent({ eventId: "2" });

    outbox.enqueue(e1);
    outbox.enqueue(e2);

    expect(outbox.pending).toEqual([e1, e2]);
    expect(outbox.totalDropped).toBe(0);
  });

  it("drops the OLDEST events (never newest) when the cap overflows, and emits an explicit dropped-count marker", () => {
    const sink: AuditSink = { deliver: vi.fn(async () => undefined) };
    const onDropped = vi.fn();
    const outbox = new AuditOutbox({ sink, cap: 2, onDropped });

    const e1 = fixtureEvent({ eventId: "1" });
    const e2 = fixtureEvent({ eventId: "2" });
    const e3 = fixtureEvent({ eventId: "3" });

    outbox.enqueue(e1);
    outbox.enqueue(e2);
    outbox.enqueue(e3); // overflow by 1 -> drops e1

    expect(outbox.pending).toEqual([e2, e3]);
    expect(outbox.totalDropped).toBe(1);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith(
      expect.objectContaining({ droppedCount: 1 }),
    );
  });

  it("never drops silently: totalDropped is observable even without an onDropped callback", () => {
    const sink: AuditSink = { deliver: vi.fn(async () => undefined) };
    const outbox = new AuditOutbox({ sink, cap: 1 });

    outbox.enqueue(fixtureEvent({ eventId: "1" }));
    outbox.enqueue(fixtureEvent({ eventId: "2" }));
    outbox.enqueue(fixtureEvent({ eventId: "3" }));

    expect(outbox.totalDropped).toBe(2);
  });

  it("rejects a non-positive cap", () => {
    const sink: AuditSink = { deliver: vi.fn(async () => undefined) };
    expect(() => new AuditOutbox({ sink, cap: 0 })).toThrow(/positive/);
  });
});

describe("AuditOutbox — flush retention and redelivery on sink failure", () => {
  it("retains events, in order, on sink failure and redelivers them once the sink recovers", async () => {
    let shouldFail = true;
    const delivered: readonly AuditEvent[][] = [];
    const sink: AuditSink = {
      deliver: vi.fn(async (events) => {
        if (shouldFail) {
          throw new Error("sink unreachable");
        }
        (delivered as AuditEvent[][]).push([...events]);
      }),
    };
    const outbox = new AuditOutbox({ sink, cap: 10 });
    const e1 = fixtureEvent({ eventId: "1" });
    const e2 = fixtureEvent({ eventId: "2" });
    outbox.enqueue(e1);
    outbox.enqueue(e2);

    await expect(outbox.flush()).rejects.toThrow("sink unreachable");
    // Retained, in order, after the failed attempt.
    expect(outbox.pending).toEqual([e1, e2]);

    shouldFail = false;
    const result = await outbox.flush();

    expect(result).toEqual({ delivered: 2, attempts: 1 });
    expect(outbox.pending).toEqual([]);
    expect(delivered).toEqual([[e1, e2]]);
  });

  it("is a no-op on an empty queue — never calls the sink", async () => {
    const deliver = vi.fn(async () => undefined);
    const outbox = new AuditOutbox({ sink: { deliver }, cap: 5 });

    const result = await outbox.flush();

    expect(result).toEqual({ delivered: 0, attempts: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("AuditOutbox — Retry-After backoff via injected clock", () => {
  it("honours Retry-After before the next attempt, and succeeds within maxAttempts", async () => {
    const clock = fakeClock();
    let attempt = 0;
    const sink: AuditSink = {
      deliver: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new RetryAfterError(5000);
        }
        // second attempt succeeds
      }),
    };
    const outbox = new AuditOutbox({ sink, cap: 5, clock });
    outbox.enqueue(fixtureEvent({ eventId: "1" }));

    const result = await outbox.flush({ maxAttempts: 2 });

    expect(result).toEqual({ delivered: 1, attempts: 2 });
    // The clock's sleep(5000) must have happened BEFORE the second attempt.
    expect(clock.sleeps).toEqual([5000]);
    expect(sink.deliver).toHaveBeenCalledTimes(2);
  });

  it("propagates RetryAfterError with the queue intact once maxAttempts is exhausted", async () => {
    const clock = fakeClock();
    const sink: AuditSink = {
      deliver: vi.fn(async () => {
        throw new RetryAfterError(1000);
      }),
    };
    const outbox = new AuditOutbox({ sink, cap: 5, clock });
    const e1 = fixtureEvent({ eventId: "1" });
    outbox.enqueue(e1);

    await expect(outbox.flush({ maxAttempts: 2 })).rejects.toBeInstanceOf(RetryAfterError);

    expect(outbox.pending).toEqual([e1]);
    // Slept once, between the two attempts, honouring Retry-After each time it was hit.
    expect(clock.sleeps).toEqual([1000]);
    expect(sink.deliver).toHaveBeenCalledTimes(2);
  });

  it("rejects retryAfterMs that is negative or non-finite", () => {
    expect(() => new RetryAfterError(-1)).toThrow(/non-negative/);
    expect(() => new RetryAfterError(Number.NaN)).toThrow(/non-negative/);
  });

  it("rejects a maxAttempts below 1", async () => {
    const sink: AuditSink = { deliver: vi.fn(async () => undefined) };
    const outbox = new AuditOutbox({ sink, cap: 5 });
    outbox.enqueue(fixtureEvent());

    await expect(outbox.flush({ maxAttempts: 0 })).rejects.toThrow(/maxAttempts/);
  });
});
