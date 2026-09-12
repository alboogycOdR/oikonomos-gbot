/** A FIFO admission gate for work that consumes an agent execution slot. */
export interface QueuedRun {
  readonly roleId: string;
  readonly position: number;
  readonly reason: "concurrency.cap";
}

export interface RunGateExecution {
  readonly queued: QueuedRun | null;
}

export interface RunGateOptions {
  readonly maxConcurrent: number;
  readonly onQueued?: (queued: QueuedRun) => void;
}

export interface RunGate {
  run<T>(roleId: string, fn: (execution: RunGateExecution) => Promise<T> | T): Promise<T>;
}

interface Entry {
  readonly roleId: string;
  readonly fn: (execution: RunGateExecution) => Promise<unknown> | unknown;
  readonly queued: QueuedRun | null;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * Limits executing work globally and serialises each role. The queue is
 * deliberately strict FIFO: a blocked head is not skipped by a later role.
 * This makes the reported queue position truthful and prevents starvation.
 */
export function createRunGate(options: RunGateOptions): RunGate {
  if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive safe integer.");
  }
  const queue: Entry[] = [];
  const activeRoles = new Set<string>();
  let active = 0;

  const pump = (): void => {
    while (active < options.maxConcurrent) {
      const next = queue[0];
      if (next === undefined || activeRoles.has(next.roleId)) return;
      queue.shift();
      active += 1;
      activeRoles.add(next.roleId);
      void Promise.resolve(next.fn({ queued: next.queued })).then(next.resolve, next.reject).finally(() => {
        active -= 1;
        activeRoles.delete(next.roleId);
        pump();
      });
    }
  };

  return {
    run<T>(roleId: string, fn: (execution: RunGateExecution) => Promise<T> | T): Promise<T> {
      const normalizedRoleId = roleId.trim();
      if (normalizedRoleId.length === 0) return Promise.reject(new Error("roleId must not be empty."));
      return new Promise<T>((resolve, reject) => {
        const queues = active >= options.maxConcurrent || queue.length > 0 || activeRoles.has(normalizedRoleId);
        const queued = queues ? { roleId: normalizedRoleId, position: queue.length + 1, reason: "concurrency.cap" as const } : null;
        if (queued !== null) options.onQueued?.(queued);
        queue.push({
          roleId: normalizedRoleId,
          fn,
          queued,
          resolve: (value) => resolve(value as T),
          reject,
        });
        pump();
      });
    },
  };
}
