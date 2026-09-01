/**
 * TASK-076 — in-process scheduling policy for durable role runs.
 *
 * This deliberately owns neither the database nor a queue transport.  Those
 * are ports because a scheduler restart must recover its D0 state from the
 * task/run repositories; it must never attempt to checkpoint a model run.
 */
export const runLanes = ["user", "agent", "background"] as const;
export type RunLane = (typeof runLanes)[number];

export interface SchedulerClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerAuditEvent {
  type: "watchdog_interrupted" | "priority_interrupted";
  roleId: string;
  runId: string;
  reason: string;
  wasInFlight: boolean;
  at: Date;
}

export interface ScheduledRun {
  runId: string;
  roleId: string;
  lane: RunLane;
  run(signal: AbortSignal, controls: RunControls): Promise<void>;
}

export interface RunControls {
  setAwaitingApproval(awaiting: boolean): void;
}

export interface RoutineFire {
  routineId: string;
  roleId: string;
  lane: RunLane;
  task: { title: string; goal: string; tenantId: string };
  nextFireAt?: Date | null;
}

export interface RoutineFirePorts {
  environmentIsUp(roleId: string): Promise<boolean>;
  createTask(input: RoutineFire["task"] & { roleId: string; routineId: string; lane: RunLane }): Promise<void>;
  recordFire(routineId: string, outcome: "queued" | "missed", nextFireAt?: Date | null): Promise<void>;
}

export interface SchedulerOptions {
  clock: SchedulerClock;
  wallClockBudgetMs: number;
  /** Defaults to one: lane ordering is meaningful at each worker slot. */
  maxConcurrentRuns?: number;
  audit(event: SchedulerAuditEvent): Promise<void> | void;
}

export interface SchedulerHealth {
  isBusy: boolean;
  busyOnlyAwaitingApproval: boolean;
  lastBusyAt: Date | null;
}

interface ActiveRun {
  job: ScheduledRun;
  controller: AbortController;
  awaitingApproval: boolean;
  watchdog: unknown;
}

const laneRank: Record<RunLane, number> = { user: 0, agent: 1, background: 2 };

function assertLane(lane: RunLane): void {
  if (!runLanes.includes(lane)) {
    throw new Error(`lane must be one of: ${runLanes.join(", ")}.`);
  }
}

/** A role-keyed scheduler. A role can have only one active run at a time. */
export class RoleRunScheduler {
  private readonly queue: ScheduledRun[] = [];
  private readonly active = new Map<string, ActiveRun>();
  private lastBusyAt: Date | null = null;
  private draining = false;

  public constructor(private readonly options: SchedulerOptions) {
    if (!Number.isFinite(options.wallClockBudgetMs) || options.wallClockBudgetMs <= 0) {
      throw new Error("wallClockBudgetMs must be a positive finite number.");
    }
    if (
      options.maxConcurrentRuns !== undefined &&
      (!Number.isInteger(options.maxConcurrentRuns) || options.maxConcurrentRuns <= 0)
    ) {
      throw new Error("maxConcurrentRuns must be a positive integer.");
    }
  }

  /** Enqueue work; user work wins over already-queued lower priority work. */
  public schedule(job: ScheduledRun): void {
    if (job.roleId.trim().length === 0 || job.runId.trim().length === 0) {
      throw new Error("runId and roleId must not be empty.");
    }
    assertLane(job.lane);
    this.queue.push(job);
    void this.drain();
  }

  public getHealth(): SchedulerHealth {
    const active = [...this.active.values()];
    return {
      isBusy: active.length > 0,
      busyOnlyAwaitingApproval: active.length > 0 && active.every((run) => run.awaitingApproval),
      lastBusyAt: this.lastBusyAt,
    };
  }

  /** Interrupt non-user work only; a user run is intentionally protected. */
  public async requestPriorityInterrupt(roleId: string, reason: string): Promise<boolean> {
    const active = this.active.get(roleId);
    if (active === undefined || active.job.lane === "user") {
      return false;
    }
    active.controller.abort(reason);
    await this.options.audit({
      type: "priority_interrupted",
      roleId,
      runId: active.job.runId,
      reason,
      wasInFlight: true,
      at: this.options.clock.now(),
    });
    return true;
  }

  /** Firing is a D0 transaction through the supplied repository ports. */
  public async fireRoutine(fire: RoutineFire, ports: RoutineFirePorts): Promise<"queued" | "missed"> {
    assertLane(fire.lane);
    if (!(await ports.environmentIsUp(fire.roleId))) {
      await ports.recordFire(fire.routineId, "missed", fire.nextFireAt);
      return "missed";
    }
    await ports.createTask({ ...fire.task, roleId: fire.roleId, routineId: fire.routineId, lane: fire.lane });
    await ports.recordFire(fire.routineId, "queued", fire.nextFireAt);
    return "queued";
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        if (this.active.size >= (this.options.maxConcurrentRuns ?? 1)) return;
        const next = this.dequeueRunnable();
        if (next === undefined) return;
        void this.start(next);
      }
    } finally {
      this.draining = false;
    }
  }

  private dequeueRunnable(): ScheduledRun | undefined {
    let selected = -1;
    for (let index = 0; index < this.queue.length; index += 1) {
      const candidate = this.queue[index];
      if (candidate === undefined || this.active.has(candidate.roleId)) continue;
      if (selected === -1 || laneRank[candidate.lane] < laneRank[this.queue[selected]!.lane]) {
        selected = index;
      }
    }
    return selected === -1 ? undefined : this.queue.splice(selected, 1)[0];
  }

  private async start(job: ScheduledRun): Promise<void> {
    const controller = new AbortController();
    const active: ActiveRun = {
      job,
      controller,
      awaitingApproval: false,
      watchdog: undefined,
    };
    this.active.set(job.roleId, active);
    this.lastBusyAt = this.options.clock.now();
    active.watchdog = this.options.clock.setTimeout(() => {
      if (this.active.get(job.roleId) !== active) return;
      controller.abort("wall-clock budget exceeded");
      void this.options.audit({
        type: "watchdog_interrupted",
        roleId: job.roleId,
        runId: job.runId,
        reason: "wall-clock budget exceeded",
        wasInFlight: true,
        at: this.options.clock.now(),
      });
    }, this.options.wallClockBudgetMs);

    try {
      await job.run(controller.signal, {
        setAwaitingApproval: (awaiting) => {
          active.awaitingApproval = awaiting;
          if (!awaiting) this.lastBusyAt = this.options.clock.now();
        },
      });
    } catch {
      // A failed run must release its role key; persistence of the failure
      // belongs to the worker's run-lifecycle port, not this policy object.
    } finally {
      this.options.clock.clearTimeout(active.watchdog);
      if (this.active.get(job.roleId) === active) this.active.delete(job.roleId);
      this.lastBusyAt = this.options.clock.now();
      void this.drain();
    }
  }
}
