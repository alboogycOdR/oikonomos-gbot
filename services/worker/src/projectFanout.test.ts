import { describe, expect, it } from "vitest";

import { createProjectFanoutAdmission, PROJECT_FANOUT_CAP_MESSAGE } from "./projectFanout.js";

describe("project fanout admission", () => {
  it("requires a run context only when an assignment is attempted", async () => {
    const admit = createProjectFanoutAdmission({ connectionString: "postgres://unused", tenantId: "tenant", fromRoleId: "manager" });
    expect(() => admit({ projectId: "11111111-1111-1111-1111-111111111111", taskId: "22222222-2222-2222-2222-222222222222", ownerRoleId: "member", rosterSize: 2 })).toThrow("run context");
  });

  it("keeps the existing model-readable cap message stable", () => {
    expect(PROJECT_FANOUT_CAP_MESSAGE).toBe("Project fan-out cap reached for this manager turn.");
  });
});
