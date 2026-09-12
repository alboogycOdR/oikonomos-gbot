import { describe, expect, it, vi } from "vitest";

import { createRunGate } from "./runConcurrency.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("createRunGate", () => {
  it("caps three roles at two and emits queue evidence for the third", async () => {
    const queued = vi.fn();
    const gate = createRunGate({ maxConcurrent: 2, onQueued: queued });
    const first = deferred(); const second = deferred(); const third = deferred();
    const started: string[] = [];
    const one = gate.run("role-1", async () => { started.push("one"); await first.promise; });
    const two = gate.run("role-2", async () => { started.push("two"); await second.promise; });
    const three = gate.run("role-3", async () => { started.push("three"); await third.promise; });
    expect(started).toEqual(["one", "two"]);
    expect(queued).toHaveBeenCalledWith({ roleId: "role-3", position: 1, reason: "concurrency.cap" });
    first.resolve(); await one;
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
    second.resolve(); third.resolve(); await Promise.all([two, three]);
  });

  it("never executes two runs for one role concurrently", async () => {
    const gate = createRunGate({ maxConcurrent: 2 });
    const release = deferred(); let active = 0; let peak = 0;
    const first = gate.run("same-role", async () => { active += 1; peak = Math.max(peak, active); await release.promise; active -= 1; });
    const second = gate.run("same-role", async () => { active += 1; peak = Math.max(peak, active); active -= 1; });
    expect(peak).toBe(1); release.resolve(); await Promise.all([first, second]); expect(peak).toBe(1);
  });

  it("never drops queued runs and preserves FIFO order per role", async () => {
    const gate = createRunGate({ maxConcurrent: 1 });
    const release = deferred(); const order: number[] = [];
    const first = gate.run("role", async () => { order.push(0); await release.promise; });
    const rest = Array.from({ length: 9 }, (_, index) => gate.run("role", () => { order.push(index + 1); }));
    release.resolve(); await Promise.all([first, ...rest]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
