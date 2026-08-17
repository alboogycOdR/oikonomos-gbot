import { describe, it, expect, vi } from "vitest";
import { AccessGuard } from "../src/security.js";

describe("AccessGuard", () => {
  it("allows a listed user id", () => {
    const guard = new AccessGuard(new Set([111]));
    expect(guard.isAllowed(111)).toBe(true);
  });

  it("denies an unlisted user id", () => {
    const guard = new AccessGuard(new Set([111]));
    expect(guard.isAllowed(222)).toBe(false);
  });

  it("throws if constructed with an empty allow-list", () => {
    expect(() => new AccessGuard(new Set())).toThrow();
  });

  it("check() returns true and does not report for an allowed user", () => {
    const onUnauthorized = vi.fn();
    const guard = new AccessGuard(new Set([111]), onUnauthorized);
    const result = guard.check({ userId: 111, chatId: 999 });
    expect(result).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("check() returns false and reports for a denied user", () => {
    const onUnauthorized = vi.fn();
    const guard = new AccessGuard(new Set([111]), onUnauthorized);
    const result = guard.check({ userId: 222, username: "eve", firstName: "Eve", chatId: 999 });
    expect(result).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 222, username: "eve", firstName: "Eve", chatId: 999 }),
    );
  });

  it("works without an onUnauthorized callback", () => {
    const guard = new AccessGuard(new Set([111]));
    expect(() => guard.check({ userId: 222, chatId: 1 })).not.toThrow();
  });
});
