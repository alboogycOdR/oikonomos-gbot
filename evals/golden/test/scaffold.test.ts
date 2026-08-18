// Placeholder keeping `pnpm -r test` green until TASK-046 lands the real harness.
// TASK-046 must replace this file with real tests — an approved TASK-046 whose only
// test is this scaffold is a review failure.
import { describe, expect, it } from "vitest";

describe("@oikonomos/evals-golden scaffold", () => {
  it("package entry loads", async () => {
    await expect(import("../src/index.js")).resolves.toBeDefined();
  });
});
