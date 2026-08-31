/**
 * Named, injectable scheduling policies (TASK-074, study §Tier 2 —
 * `internal/scheduling.ts` reference). Every policy:
 *
 *  - takes an injected {@link Clock} instead of calling the global
 *    `setTimeout`/`clearTimeout` directly, so tests are deterministic
 *    (a fake-clock test double) and never rely on Vitest's global
 *    fake-timer machinery;
 *  - validates its constructor options eagerly, throwing `RangeError`
 *    synchronously rather than failing later at call time;
 *  - carries a mandatory non-empty `name`, so a timeout/exhaustion error
 *    is always attributable to the policy instance that raised it
 *    ({@link DeadlineExceededError.policyName} and friends);
 *  - `unref()`s every timer it schedules, so a policy alone never keeps
 *    the Node event loop alive.
 *
 * Zero runtime dependencies (packages/shared's standing constraint) —
 * `node:timers`/`globalThis` only, via {@link SystemClock}. Adoption by
 * other packages is a separate task; this module only defines the
 * policies.
 */

/** The subset of a Node timer handle every policy needs: the ability to `unref()` it. */
export interface TimerHandle {
  unref(): void;
}

/**
 * The injected time/timer source every policy in this module depends on,
 * instead of calling `setTimeout`/`clearTimeout` globally. Pass
 * {@link SystemClock} in production, a deterministic fake in tests.
 */
export interface Clock {
  /** Current time in milliseconds, semantics matching `Date.now()`. */
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The real system clock — `globalThis.setTimeout`/`clearTimeout`, `Date.now()`. */
export const SystemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};

/** Validates the mandatory `name` field shared by every policy's options. Throws `RangeError` if invalid. */
function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new RangeError("policy name must be a non-empty string");
  }
}

function validatePositiveFiniteNumber(name: string, field: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name}: ${field} must be a positive finite number`);
  }
}

function validateNonNegativeFiniteNumber(name: string, field: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name}: ${field} must be a non-negative finite number`);
  }
}

function validatePositiveInteger(name: string, field: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name}: ${field} must be a positive integer`);
  }
}

/** Schedules `resolve()` after `ms` on `clock`, unref'd. Shared by policies that need to await a delay. */
function delay(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(() => resolve(), ms);
    timer.unref();
  });
}

// ---------------------------------------------------------------------------
// DeadlinePolicy
// ---------------------------------------------------------------------------

/** Raised when a {@link DeadlinePolicy} fires before being cleared. */
export class DeadlineExceededError extends Error {
  readonly policyName: string;

  constructor(policyName: string) {
    super(`deadline exceeded: ${policyName}`);
    this.name = "DeadlineExceededError";
    this.policyName = policyName;
  }
}

export interface DeadlinePolicyOptions {
  /** Non-empty, attributable name — appears on {@link DeadlineExceededError.policyName}. */
  readonly name: string;
  /** Deadline duration in milliseconds. Must be a positive finite number. */
  readonly timeoutMs: number;
  readonly clock: Clock;
}

/**
 * A single named deadline. `start()` returns a promise that rejects with
 * {@link DeadlineExceededError} if `clear()` is not called first.
 */
export class DeadlinePolicy {
  readonly name: string;
  private readonly timeoutMs: number;
  private readonly clock: Clock;
  private timer: TimerHandle | null = null;

  constructor(options: DeadlinePolicyOptions) {
    validateName(options.name);
    validatePositiveFiniteNumber(options.name, "timeoutMs", options.timeoutMs);
    this.name = options.name;
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock;
  }

  /**
   * Arms the deadline. Returns a promise that rejects with
   * {@link DeadlineExceededError} unless `clear()` runs first. Re-arming
   * (calling `start()` again) implicitly clears any prior timer.
   */
  start(): Promise<never> {
    this.clear();
    return new Promise((_resolve, reject) => {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        reject(new DeadlineExceededError(this.name));
      }, this.timeoutMs);
      this.timer.unref();
    });
  }

  /** Cancels the pending deadline, if any. Idempotent. */
  clear(): void {
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// RetryPolicy
// ---------------------------------------------------------------------------

/** Raised when a {@link RetryPolicy} exhausts `maxAttempts` without success. */
export class RetryExhaustedError extends Error {
  readonly policyName: string;
  readonly attempts: number;
  override readonly cause: unknown;

  constructor(policyName: string, attempts: number, cause: unknown) {
    super(`retry exhausted: ${policyName} after ${attempts} attempt(s)`);
    this.name = "RetryExhaustedError";
    this.policyName = policyName;
    this.attempts = attempts;
    this.cause = cause;
  }
}

export interface RetryPolicyOptions {
  readonly name: string;
  /** Maximum number of attempts (including the first). Positive integer. */
  readonly maxAttempts: number;
  /** Base delay in milliseconds before the first retry. Non-negative. */
  readonly baseDelayMs: number;
  /** Ceiling applied to the exponential backoff. Must be >= baseDelayMs. */
  readonly maxDelayMs: number;
  readonly clock: Clock;
}

/** Exponential-backoff retry with a named, attributable exhaustion error. */
export class RetryPolicy {
  readonly name: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly clock: Clock;

  constructor(options: RetryPolicyOptions) {
    validateName(options.name);
    validatePositiveInteger(options.name, "maxAttempts", options.maxAttempts);
    validateNonNegativeFiniteNumber(options.name, "baseDelayMs", options.baseDelayMs);
    validateNonNegativeFiniteNumber(options.name, "maxDelayMs", options.maxDelayMs);
    if (options.maxDelayMs < options.baseDelayMs) {
      throw new RangeError(`${options.name}: maxDelayMs must be >= baseDelayMs`);
    }
    this.name = options.name;
    this.maxAttempts = options.maxAttempts;
    this.baseDelayMs = options.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs;
    this.clock = options.clock;
  }

  /** The backoff delay (ms) that would follow the given 1-based attempt number. */
  delayForAttempt(attempt: number): number {
    const exponential = this.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, this.maxDelayMs);
  }

  /**
   * Runs `fn` up to `maxAttempts` times, sleeping the exponential backoff
   * (via the injected clock) between attempts. Throws
   * {@link RetryExhaustedError} — with the last error as `cause` — if every
   * attempt fails.
   */
  async execute<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts) {
          await delay(this.clock, this.delayForAttempt(attempt));
        }
      }
    }
    throw new RetryExhaustedError(this.name, this.maxAttempts, lastError);
  }
}

// ---------------------------------------------------------------------------
// PollingPolicy
// ---------------------------------------------------------------------------

/** Raised when a {@link PollingPolicy} exhausts its bounded attempt count without a result. */
export class PollingExhaustedError extends Error {
  readonly policyName: string;
  readonly attempts: number;

  constructor(policyName: string, attempts: number) {
    super(`polling exhausted: ${policyName} after ${attempts} attempt(s)`);
    this.name = "PollingExhaustedError";
    this.policyName = policyName;
    this.attempts = attempts;
  }
}

export interface PollingPolicyOptions {
  readonly name: string;
  /** Interval between polls, in milliseconds. Positive finite number. */
  readonly intervalMs: number;
  readonly clock: Clock;
  /** Optional cap on attempts; unbounded (poll forever until success or `stop()`) if omitted. */
  readonly maxAttempts?: number;
}

/** Polls `fn` at a fixed interval until it returns a defined value, is stopped, or exhausts `maxAttempts`. */
export class PollingPolicy {
  readonly name: string;
  private readonly intervalMs: number;
  private readonly clock: Clock;
  private readonly maxAttempts: number;
  private stopped = false;

  constructor(options: PollingPolicyOptions) {
    validateName(options.name);
    validatePositiveFiniteNumber(options.name, "intervalMs", options.intervalMs);
    if (options.maxAttempts !== undefined) {
      validatePositiveInteger(options.name, "maxAttempts", options.maxAttempts);
    }
    this.name = options.name;
    this.intervalMs = options.intervalMs;
    this.clock = options.clock;
    this.maxAttempts = options.maxAttempts ?? Infinity;
  }

  /** Signals the in-flight `poll()` loop to stop before its next attempt. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Calls `fn(attempt)` repeatedly, waiting `intervalMs` (via the clock)
   * between calls, until `fn` resolves to a value other than `undefined`.
   * Throws {@link PollingExhaustedError} if `stop()` is called or
   * `maxAttempts` is reached first.
   */
  async poll<T>(fn: (attempt: number) => Promise<T | undefined>): Promise<T> {
    this.stopped = false;
    let attempt = 0;
    while (!this.stopped && attempt < this.maxAttempts) {
      attempt++;
      const result = await fn(attempt);
      if (result !== undefined) {
        return result;
      }
      if (this.stopped || attempt >= this.maxAttempts) {
        break;
      }
      await delay(this.clock, this.intervalMs);
    }
    throw new PollingExhaustedError(this.name, attempt);
  }
}

// ---------------------------------------------------------------------------
// IdleWatchdogPolicy
// ---------------------------------------------------------------------------

export interface IdleWatchdogPolicyOptions {
  readonly name: string;
  /** Idle duration (ms) after the last `poke()` before `onIdle` fires. Positive finite number. */
  readonly idleTimeoutMs: number;
  readonly clock: Clock;
  /** Invoked with the policy's name when the idle timeout elapses without a `poke()`. */
  readonly onIdle: (policyName: string) => void;
}

/** Fires `onIdle` if `poke()` is not called again within `idleTimeoutMs`. */
export class IdleWatchdogPolicy {
  readonly name: string;
  private readonly idleTimeoutMs: number;
  private readonly clock: Clock;
  private readonly onIdle: (policyName: string) => void;
  private timer: TimerHandle | null = null;
  private disposed = false;

  constructor(options: IdleWatchdogPolicyOptions) {
    validateName(options.name);
    validatePositiveFiniteNumber(options.name, "idleTimeoutMs", options.idleTimeoutMs);
    if (typeof options.onIdle !== "function") {
      throw new RangeError(`${options.name}: onIdle must be a function`);
    }
    this.name = options.name;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.clock = options.clock;
    this.onIdle = options.onIdle;
  }

  /** Records activity: (re)arms the idle timer, cancelling any prior one. No-op after `dispose()`. */
  poke(): void {
    if (this.disposed) {
      return;
    }
    this.clearTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.onIdle(this.name);
    }, this.idleTimeoutMs);
    this.timer.unref();
  }

  /** Permanently stops the watchdog and cancels any pending timer. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// DebouncePolicy
// ---------------------------------------------------------------------------

export interface DebouncePolicyOptions {
  readonly name: string;
  /** Debounce window in milliseconds. Non-negative finite number (0 is legal — next tick). */
  readonly delayMs: number;
  readonly clock: Clock;
}

/** Collapses a burst of `trigger()` calls into a single trailing invocation. */
export class DebouncePolicy {
  readonly name: string;
  private readonly delayMs: number;
  private readonly clock: Clock;
  private timer: TimerHandle | null = null;

  constructor(options: DebouncePolicyOptions) {
    validateName(options.name);
    validateNonNegativeFiniteNumber(options.name, "delayMs", options.delayMs);
    this.name = options.name;
    this.delayMs = options.delayMs;
    this.clock = options.clock;
  }

  /** Schedules `fn` after the debounce window, cancelling any call already pending. */
  trigger(fn: () => void): void {
    this.cancel();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      fn();
    }, this.delayMs);
    this.timer.unref();
  }

  /** Cancels a pending trailing call, if any. Idempotent. */
  cancel(): void {
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Whether a trailing call is currently pending. */
  get pending(): boolean {
    return this.timer !== null;
  }
}
