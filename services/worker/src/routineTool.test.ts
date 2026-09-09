import { describe, expect, it } from "vitest";

import { describeCron, nextFireAtFromCron, parseCreateRoutineInput } from "./routineTool.js";

describe("describeCron — best-effort human description for the chat confirmation", () => {
  it("describes a daily schedule", () => {
    expect(describeCron("0 14 * * *")).toBe("every day at 2:00 PM");
    expect(describeCron("30 9 * * *")).toBe("every day at 9:30 AM");
    expect(describeCron("0 0 * * *")).toBe("every day at 12:00 AM");
    expect(describeCron("0 12 * * *")).toBe("every day at 12:00 PM");
  });

  it("describes a weekly schedule on a specific weekday", () => {
    expect(describeCron("0 9 * * 1")).toBe("every Monday at 9:00 AM");
    expect(describeCron("0 9 * * 0")).toBe("every Sunday at 9:00 AM");
    expect(describeCron("0 9 * * 6")).toBe("every Saturday at 9:00 AM");
  });

  it("falls back to the raw expression for anything it doesn't recognize, rather than guessing wrong", () => {
    expect(describeCron("0 9 1 * *")).toBe("on schedule: 0 9 1 * *"); // specific day-of-month
    expect(describeCron("*/15 * * * *")).toBe("on schedule: */15 * * * *"); // every 15 minutes
    expect(describeCron("not a cron")).toBe("on schedule: not a cron");
    expect(describeCron("0 9 * * *  ")).toBe("every day at 9:00 AM"); // trims whitespace
  });
});

describe("nextFireAtFromCron — mirrors control-api's own validation exactly", () => {
  it("computes a real future fire time for a valid expression", () => {
    const result = nextFireAtFromCron("0 14 * * *");
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects anything that isn't exactly 5 fields", () => {
    expect(() => nextFireAtFromCron("* * * *")).toThrow(/5-field cron/);
    expect(() => nextFireAtFromCron("* * * * * *")).toThrow(/5-field cron/);
  });

  it("rejects a syntactically-5-field but semantically invalid expression", () => {
    expect(() => nextFireAtFromCron("99 99 * * *")).toThrow(/5-field cron/);
  });
});

describe("parseCreateRoutineInput — the tool's own input validation", () => {
  it("requires a non-empty name and schedule", () => {
    expect(() => parseCreateRoutineInput({ schedule: "0 9 * * *" })).toThrow(/name/);
    expect(() => parseCreateRoutineInput({ name: "  " })).toThrow(/name/);
    expect(() => parseCreateRoutineInput({ name: "x" })).toThrow(/schedule/);
    expect(() => parseCreateRoutineInput({ name: "x", schedule: "  " })).toThrow(/schedule/);
  });

  it("trims strings and omits optional fields when blank/absent", () => {
    expect(parseCreateRoutineInput({ name: " Daily weather ", schedule: " 0 14 * * * " })).toEqual({
      name: "Daily weather",
      schedule: "0 14 * * *",
    });
  });

  it("includes goal/skillId only when genuinely provided", () => {
    expect(parseCreateRoutineInput({ name: "x", schedule: "0 9 * * *", goal: "Check things", skillId: "skill-1" }))
      .toEqual({ name: "x", schedule: "0 9 * * *", goal: "Check things", skillId: "skill-1" });
    expect(parseCreateRoutineInput({ name: "x", schedule: "0 9 * * *", goal: "" }))
      .toEqual({ name: "x", schedule: "0 9 * * *" });
  });

  it("rejects a non-string goal/skillId rather than silently coercing it", () => {
    expect(() => parseCreateRoutineInput({ name: "x", schedule: "0 9 * * *", goal: 123 })).toThrow(/goal/);
    expect(() => parseCreateRoutineInput({ name: "x", schedule: "0 9 * * *", skillId: 123 })).toThrow(/skillId/);
  });
});
