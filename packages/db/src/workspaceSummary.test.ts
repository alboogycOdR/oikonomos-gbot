import { describe, expect, it } from "vitest";

import { listWorkspaceSummary } from "./workspaceSummary.js";

describe("listWorkspaceSummary (TASK-237)", () => {
  it("rejects a blank tenant before it can query", async () => {
    await expect(listWorkspaceSummary({ connectionString: "postgres://unused.invalid/test" }, " ")).rejects.toThrow(/tenantId/);
  });
});
