import { describe, expect, it } from "vitest";

import { RoleRunScheduler, type SchedulerClock } from "../src/scheduler/scheduler.js";

class FakeClock implements SchedulerClock {
  public current = new Date("2026-09-02T01:00:00Z");
  private readonly timers = new Map<number, () => void>();
  private nextTimer = 0;

  public now(): Date { return new Date(this.current); }
  public setTimeout(callback: () => void): unknown { this.timers.set(this.nextTimer, callback); return this.nextTimer++; }
  public clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  public fireAll(): void { for (const callback of [...this.timers.values()]) callback(); }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe("TASK-076 role scheduler", () => {
  it("serializes a role and lets a failed run release its lane", async () => {
    const clock = new FakeClock();
    const scheduler = new RoleRunScheduler({ clock, wallClockBudgetMs: 1000, audit: () => undefined });
    const first = deferred();
    const started: string[] = [];
    scheduler.schedule({ runId: "one", roleId: "role-a", lane: "agent", run: async () => { started.push("one"); await first.promise; throw new Error("expected"); } });
    scheduler.schedule({ runId: "two", roleId: "role-a", lane: "agent", run: async () => { started.push("two"); } });
    await flush();
    expect(started).toEqual(["one"]);
    first.resolve();
    await flush();
    expect(started).toEqual(["one", "two"]);
  });

  it("dequeues user work before already queued background work", async () => {
    const clock = new FakeClock();
    const scheduler = new RoleRunScheduler({ clock, wallClockBudgetMs: 1000, audit: () => undefined });
    const gate = deferred(); const order: string[] = [];
    scheduler.schedule({ runId: "block", roleId: "block", lane: "agent", run: async () => { await gate.promise; } });
    scheduler.schedule({ runId: "background", roleId: "bg", lane: "background", run: async () => { order.push("background"); } });
    scheduler.schedule({ runId: "user", roleId: "user", lane: "user", run: async () => { order.push("user"); } });
    await flush(); gate.resolve(); await flush();
    expect(order).toEqual(["user", "background"]);
  });

  it("freezes lastBusyAt while every active run awaits approval", async () => {
    const clock = new FakeClock(); const gate = deferred();
    const scheduler = new RoleRunScheduler({ clock, wallClockBudgetMs: 1000, audit: () => undefined });
    scheduler.schedule({ runId: "approval", roleId: "role", lane: "agent", run: async (_signal, controls) => { controls.setAwaitingApproval(true); await gate.promise; } });
    await flush(); const before = scheduler.getHealth().lastBusyAt;
    clock.current = new Date("2026-09-02T02:00:00Z");
    expect(scheduler.getHealth()).toEqual({ isBusy: true, busyOnlyAwaitingApproval: true, lastBusyAt: before });
    gate.resolve(); await flush();
  });

  it("audits watchdog interruption", async () => {
    const clock = new FakeClock(); const gate = deferred(); const audit: unknown[] = [];
    const scheduler = new RoleRunScheduler({ clock, wallClockBudgetMs: 1, audit: (event) => audit.push(event) });
    scheduler.schedule({ runId: "slow", roleId: "role", lane: "background", run: async (signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); gate.resolve(); } });
    await flush(); clock.fireAll(); await flush();
    expect(audit).toContainEqual(expect.objectContaining({ type: "watchdog_interrupted", runId: "slow", wasInFlight: true }));
  });

  it("fires routines into their configured lane and records down environments as missed", async () => {
    const clock = new FakeClock(); const scheduler = new RoleRunScheduler({ clock, wallClockBudgetMs: 1, audit: () => undefined });
    const created: unknown[] = []; const fired: unknown[] = [];
    const fire = { routineId: "routine", roleId: "role", lane: "agent" as const, task: { title: "t", goal: "g", tenantId: "basileia" } };
    const ports = { environmentIsUp: async () => true, createTask: async (task: unknown) => { created.push(task); }, recordFire: async (...args: unknown[]) => { fired.push(args); } };
    await expect(scheduler.fireRoutine(fire, ports)).resolves.toBe("queued");
    expect(created).toContainEqual(expect.objectContaining({ lane: "agent", routineId: "routine" }));
    await expect(scheduler.fireRoutine(fire, { ...ports, environmentIsUp: async () => false })).resolves.toBe("missed");
    expect(fired).toContainEqual(["routine", "missed", undefined]);
  });

  it("preempts agent work and records reason/wasInFlight, but protects user work", async () => {
    const clock = new FakeClock(); const audit: unknown[] = []; const agentDone = deferred(); const userDone = deferred();
    const scheduler = new RoleRunScheduler({ clock, wallClockBudgetMs: 1000, audit: (event) => audit.push(event) });
    scheduler.schedule({ runId: "agent", roleId: "agent-role", lane: "agent", run: async (signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true })); agentDone.resolve(); } });
    await flush();
    await expect(scheduler.requestPriorityInterrupt("agent-role", "urgent handoff")).resolves.toBe(true);
    await agentDone.promise;
    expect(audit).toContainEqual(expect.objectContaining({ type: "priority_interrupted", reason: "urgent handoff", wasInFlight: true }));
    scheduler.schedule({ runId: "user", roleId: "user-role", lane: "user", run: async (signal) => { signal.addEventListener("abort", () => { throw new Error("user run must not abort"); }); await userDone.promise; } });
    await flush();
    await expect(scheduler.requestPriorityInterrupt("user-role", "urgent handoff")).resolves.toBe(false);
    expect(scheduler.getHealth().isBusy).toBe(true);
    userDone.resolve(); await flush();
  });
});
