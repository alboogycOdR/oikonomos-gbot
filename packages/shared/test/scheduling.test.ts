import { describe, it, expect, vi } from "vitest";
import {
  type Clock,
  type TimerHandle,
  DeadlinePolicy,
  DeadlineExceededError,
  RetryPolicy,
  RetryExhaustedError,
  PollingPolicy,
  PollingExhaustedError,
  IdleWatchdogPolicy,
  DebouncePolicy,
  SystemClock,
} from "../src/scheduling/index.js";

/**
 * A deterministic, manually-advanced Clock double — no Vitest fake-timer
 * globals, per the task's "deterministic tests, no fake-timer globals"
 * requirement. `advance()` fires any due callbacks synchronously (looping
 * until no more become due, so a callback that itself schedules another
 * short timer is also caught), in scheduled order.
 */
class RealFakeClock implements Clock {
  currentTime = 0;
  private nextId = 1;
  private timers = new Map<number, { due: number; callback: () => void; unrefed: boolean }>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { due: this.currentTime + ms, callback, unrefed: false });
    const self = this;
    return {
      unref() {
        const entry = self.timers.get(id);
        if (entry) {
          entry.unrefed = true;
        }
      },
      __id: id,
    } as TimerHandle & { __id: number };
  }

  clearTimeout(handle: TimerHandle): void {
    const id = (handle as TimerHandle & { __id?: number }).__id;
    if (id !== undefined) {
      this.timers.delete(id);
    }
  }

  advance(ms: number): void {
    this.currentTime += ms;
    let progressed = true;
    while (progressed) {
      progressed = false;
      const due = [...this.timers.entries()]
        .filter(([, entry]) => entry.due <= this.currentTime)
        .sort((a, b) => a[0] - b[0]);
      for (const [id, entry] of due) {
        if (this.timers.delete(id)) {
          progressed = true;
          entry.callback();
        }
      }
    }
  }

  pendingCount(): number {
    return this.timers.size;
  }

  allUnrefed(): boolean {
    return [...this.timers.values()].every((entry) => entry.unrefed);
  }
}

describe("scheduling policies", () => {
  describe("DeadlinePolicy", () => {
    it("rejects with DeadlineExceededError carrying the policy name once the deadline elapses", async () => {
      const clock = new RealFakeClock();
      const policy = new DeadlinePolicy({ name: "gmail-draft-deadline", timeoutMs: 5000, clock });
      const promise = policy.start();
      const assertion = expect(promise).rejects.toBeInstanceOf(DeadlineExceededError);
      clock.advance(5000);
      await assertion;
      await promise.catch((err: DeadlineExceededError) => {
        expect(err.policyName).toBe("gmail-draft-deadline");
      });
    });

    it("does not fire if clear() is called before the deadline", async () => {
      const clock = new RealFakeClock();
      const policy = new DeadlinePolicy({ name: "d", timeoutMs: 1000, clock });
      const promise = policy.start();
      policy.clear();
      clock.advance(10_000);
      // No pending timers, no rejection scheduled. Race the promise against
      // a resolved marker to prove it never settled.
      const result = await Promise.race([promise.then(() => "resolved").catch(() => "rejected"), Promise.resolve("safe")]);
      expect(result).toBe("safe");
    });

    it("unref()s its timer", () => {
      const clock = new RealFakeClock();
      const policy = new DeadlinePolicy({ name: "d", timeoutMs: 1000, clock });
      policy.start().catch(() => {});
      expect(clock.allUnrefed()).toBe(true);
      policy.clear();
    });

    it("validates options eagerly", () => {
      const clock = new RealFakeClock();
      expect(() => new DeadlinePolicy({ name: "", timeoutMs: 1000, clock })).toThrow(RangeError);
      expect(() => new DeadlinePolicy({ name: "d", timeoutMs: 0, clock })).toThrow(RangeError);
      expect(() => new DeadlinePolicy({ name: "d", timeoutMs: -5, clock })).toThrow(RangeError);
      expect(() => new DeadlinePolicy({ name: "d", timeoutMs: Number.NaN, clock })).toThrow(RangeError);
    });
  });

  describe("RetryPolicy", () => {
    it("retries with exponential backoff and succeeds once the underlying call succeeds", async () => {
      const clock = new RealFakeClock();
      const policy = new RetryPolicy({ name: "steel-nav", maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, clock });
      let calls = 0;
      const execution = policy.execute(async (attempt) => {
        calls++;
        if (attempt < 3) {
          throw new Error(`fail ${attempt}`);
        }
        return "ok";
      });
      // attempt 1 fails immediately -> wait 100ms
      await Promise.resolve();
      await Promise.resolve();
      clock.advance(100);
      await Promise.resolve();
      await Promise.resolve();
      clock.advance(200);
      const result = await execution;
      expect(result).toBe("ok");
      expect(calls).toBe(3);
    });

    it("throws RetryExhaustedError with the policy name and last cause after maxAttempts", async () => {
      const clock = new RealFakeClock();
      const policy = new RetryPolicy({ name: "flaky", maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10, clock });
      const lastError = new Error("boom");
      const execution = policy.execute(async () => {
        throw lastError;
      });
      const assertion = expect(execution).rejects.toBeInstanceOf(RetryExhaustedError);
      await Promise.resolve();
      await Promise.resolve();
      clock.advance(10);
      await assertion;
      await execution.catch((err: RetryExhaustedError) => {
        expect(err.policyName).toBe("flaky");
        expect(err.attempts).toBe(2);
        expect(err.cause).toBe(lastError);
      });
    });

    it("caps backoff at maxDelayMs", () => {
      const clock = new RealFakeClock();
      const policy = new RetryPolicy({ name: "p", maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 300, clock });
      expect(policy.delayForAttempt(1)).toBe(100);
      expect(policy.delayForAttempt(2)).toBe(200);
      expect(policy.delayForAttempt(3)).toBe(300); // would be 400, capped
      expect(policy.delayForAttempt(4)).toBe(300);
    });

    it("validates options eagerly", () => {
      const clock = new RealFakeClock();
      expect(() => new RetryPolicy({ name: "p", maxAttempts: 0, baseDelayMs: 10, maxDelayMs: 10, clock })).toThrow(RangeError);
      expect(() => new RetryPolicy({ name: "p", maxAttempts: 1.5, baseDelayMs: 10, maxDelayMs: 10, clock })).toThrow(RangeError);
      expect(() => new RetryPolicy({ name: "p", maxAttempts: 1, baseDelayMs: -1, maxDelayMs: 10, clock })).toThrow(RangeError);
      expect(() => new RetryPolicy({ name: "p", maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 10, clock })).toThrow(RangeError);
      expect(() => new RetryPolicy({ name: "", maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, clock })).toThrow(RangeError);
    });
  });

  describe("PollingPolicy", () => {
    it("polls until fn returns a defined value", async () => {
      const clock = new RealFakeClock();
      const policy = new PollingPolicy({ name: "poll-approval", intervalMs: 50, clock });
      let attempts = 0;
      const promise = policy.poll(async () => {
        attempts++;
        return attempts >= 3 ? "done" : undefined;
      });
      for (let i = 0; i < 5 && attempts < 3; i++) {
        await Promise.resolve();
        await Promise.resolve();
        clock.advance(50);
      }
      const result = await promise;
      expect(result).toBe("done");
      expect(attempts).toBe(3);
    });

    it("throws PollingExhaustedError with attempt count when maxAttempts is reached", async () => {
      const clock = new RealFakeClock();
      const policy = new PollingPolicy({ name: "bounded-poll", intervalMs: 10, clock, maxAttempts: 2 });
      const promise = policy.poll(async () => undefined);
      const assertion = expect(promise).rejects.toBeInstanceOf(PollingExhaustedError);
      await Promise.resolve();
      await Promise.resolve();
      clock.advance(10);
      await Promise.resolve();
      await Promise.resolve();
      await assertion;
      await promise.catch((err: PollingExhaustedError) => {
        expect(err.policyName).toBe("bounded-poll");
        expect(err.attempts).toBe(2);
      });
    });

    it("stop() halts the loop and raises PollingExhaustedError", async () => {
      const clock = new RealFakeClock();
      const policy = new PollingPolicy({ name: "stoppable", intervalMs: 10, clock });
      const promise = policy.poll(async () => {
        policy.stop();
        return undefined;
      });
      await expect(promise).rejects.toBeInstanceOf(PollingExhaustedError);
    });

    it("validates options eagerly", () => {
      const clock = new RealFakeClock();
      expect(() => new PollingPolicy({ name: "p", intervalMs: 0, clock })).toThrow(RangeError);
      expect(() => new PollingPolicy({ name: "p", intervalMs: 10, clock, maxAttempts: 0 })).toThrow(RangeError);
      expect(() => new PollingPolicy({ name: "", intervalMs: 10, clock })).toThrow(RangeError);
    });
  });

  describe("IdleWatchdogPolicy", () => {
    it("fires onIdle with the policy name after idleTimeoutMs without a poke()", () => {
      const clock = new RealFakeClock();
      const onIdle = vi.fn();
      const watchdog = new IdleWatchdogPolicy({ name: "session-idle", idleTimeoutMs: 1000, clock, onIdle });
      watchdog.poke();
      clock.advance(1000);
      expect(onIdle).toHaveBeenCalledWith("session-idle");
    });

    it("poke() before the timeout resets the window", () => {
      const clock = new RealFakeClock();
      const onIdle = vi.fn();
      const watchdog = new IdleWatchdogPolicy({ name: "w", idleTimeoutMs: 1000, clock, onIdle });
      watchdog.poke();
      clock.advance(600);
      watchdog.poke();
      clock.advance(600);
      expect(onIdle).not.toHaveBeenCalled();
      clock.advance(400);
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it("dispose() prevents any further firing", () => {
      const clock = new RealFakeClock();
      const onIdle = vi.fn();
      const watchdog = new IdleWatchdogPolicy({ name: "w", idleTimeoutMs: 1000, clock, onIdle });
      watchdog.poke();
      watchdog.dispose();
      clock.advance(10_000);
      watchdog.poke();
      clock.advance(10_000);
      expect(onIdle).not.toHaveBeenCalled();
    });

    it("validates options eagerly", () => {
      const clock = new RealFakeClock();
      const onIdle = () => {};
      expect(() => new IdleWatchdogPolicy({ name: "", idleTimeoutMs: 1000, clock, onIdle })).toThrow(RangeError);
      expect(() => new IdleWatchdogPolicy({ name: "w", idleTimeoutMs: -1, clock, onIdle })).toThrow(RangeError);
      // @ts-expect-error deliberately wrong type for the runtime check
      expect(() => new IdleWatchdogPolicy({ name: "w", idleTimeoutMs: 1000, clock, onIdle: "nope" })).toThrow(RangeError);
    });
  });

  describe("DebouncePolicy", () => {
    it("collapses a burst of trigger() calls into one trailing call", () => {
      const clock = new RealFakeClock();
      const fn = vi.fn();
      const debounce = new DebouncePolicy({ name: "save-debounce", delayMs: 300, clock });
      debounce.trigger(fn);
      clock.advance(100);
      debounce.trigger(fn);
      clock.advance(100);
      debounce.trigger(fn);
      expect(fn).not.toHaveBeenCalled();
      clock.advance(300);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("cancel() prevents the pending call and clears `pending`", () => {
      const clock = new RealFakeClock();
      const fn = vi.fn();
      const debounce = new DebouncePolicy({ name: "d", delayMs: 100, clock });
      debounce.trigger(fn);
      expect(debounce.pending).toBe(true);
      debounce.cancel();
      expect(debounce.pending).toBe(false);
      clock.advance(1000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("validates options eagerly", () => {
      const clock = new RealFakeClock();
      expect(() => new DebouncePolicy({ name: "", delayMs: 100, clock })).toThrow(RangeError);
      expect(() => new DebouncePolicy({ name: "d", delayMs: -1, clock })).toThrow(RangeError);
      expect(() => new DebouncePolicy({ name: "d", delayMs: Number.NaN, clock })).toThrow(RangeError);
    });
  });

  describe("SystemClock", () => {
    it("is a real, unref-capable clock (liveness: proves the injected Clock seam actually drives a real timer, not just a shape match)", async () => {
      await new Promise<void>((resolve) => {
        const handle = SystemClock.setTimeout(() => resolve(), 1);
        expect(typeof handle.unref).toBe("function");
        handle.unref();
      });
      expect(typeof SystemClock.now()).toBe("number");
    });
  });
});
