import { describe, it, expect, vi } from "vitest";
import {
  PermissionBroker,
  approveCallbackData,
  denyCallbackData,
  APPROVE_PREFIX,
  DENY_PREFIX,
} from "./src/bot/permissions.js";

describe("callback data helpers", () => {
  it("builds approve/deny callback data with the expected prefixes", () => {
    expect(approveCallbackData("req-1")).toBe(`${APPROVE_PREFIX}req-1`);
    expect(denyCallbackData("req-1")).toBe(`${DENY_PREFIX}req-1`);
  });

  it("stays within Telegram's 64-byte callback_data limit for a typical UUID", () => {
    const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(Buffer.byteLength(approveCallbackData(uuid), "utf-8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(denyCallbackData(uuid), "utf-8")).toBeLessThanOrEqual(64);
  });
});

describe("PermissionBroker", () => {
  it("resolves a registered request with the decision passed to resolve()", async () => {
    const broker = new PermissionBroker();
    const promise = broker.register("req-1", 100);
    const resolved = broker.resolve("req-1", 100, { allow: true });
    expect(resolved).toBe(true);
    await expect(promise).resolves.toEqual({ allow: true });
  });

  it("resolves a deny decision with a reason", async () => {
    const broker = new PermissionBroker();
    const promise = broker.register("req-1", 100);
    broker.resolve("req-1", 100, { allow: false, reason: "no" });
    await expect(promise).resolves.toEqual({ allow: false, reason: "no" });
  });

  it("returns false and does not resolve when the chatId does not match (anti-spoofing)", async () => {
    const broker = new PermissionBroker();
    const promise = broker.register("req-1", 100);
    const resolvedByWrongChat = broker.resolve("req-1", 999, { allow: true });
    expect(resolvedByWrongChat).toBe(false);

    const resolved = broker.resolve("req-1", 100, { allow: true });
    expect(resolved).toBe(true);
    await expect(promise).resolves.toEqual({ allow: true });
  });

  it("returns false when resolving an unknown request id", () => {
    const broker = new PermissionBroker();
    expect(broker.resolve("does-not-exist", 1, { allow: true })).toBe(false);
  });

  it("resolving twice is a no-op the second time", () => {
    const broker = new PermissionBroker();
    broker.register("req-1", 100);
    expect(broker.resolve("req-1", 100, { allow: true })).toBe(true);
    expect(broker.resolve("req-1", 100, { allow: true })).toBe(false);
  });

  it("tracks pendingCount accurately across register/resolve", () => {
    const broker = new PermissionBroker();
    expect(broker.pendingCount()).toBe(0);
    broker.register("a", 1);
    broker.register("b", 1);
    expect(broker.pendingCount()).toBe(2);
    broker.resolve("a", 1, { allow: true });
    expect(broker.pendingCount()).toBe(1);
  });

  it("sweepExpired denies and removes requests older than the timeout", async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker(1000);
      const promise = broker.register("req-1", 100);

      vi.advanceTimersByTime(1500);
      const expiredCount = broker.sweepExpired();

      expect(expiredCount).toBe(1);
      expect(broker.pendingCount()).toBe(0);
      await expect(promise).resolves.toMatchObject({ allow: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweepExpired leaves requests that are still within the timeout window", () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker(10_000);
      broker.register("req-1", 100);
      vi.advanceTimersByTime(2000);
      expect(broker.sweepExpired()).toBe(0);
      expect(broker.pendingCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
