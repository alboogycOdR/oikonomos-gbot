import { describe, expect, it } from "vitest";

import { getRoleSandbox, roleSandboxStates, updateRoleSandboxState, upsertRoleSandbox } from "./roleSandboxes.js";

describe("role sandboxes input validation", () => {
  const options = { connectionString: "postgres://x" };

  it("keeps the persisted lifecycle vocabulary aligned with OpenSandbox", () => {
    expect(roleSandboxStates).toContain("Paused");
    expect(roleSandboxStates).toContain("Running");
  });

  it("rejects invalid identifiers and lifecycle states before a connection is opened", async () => {
    await expect(getRoleSandbox(options, " ")).rejects.toThrow(/roleId/);
    await expect(upsertRoleSandbox(options, {
      roleId: "role", sandboxId: "sandbox", state: "nope" as never, execdTokenRef: "secret://x",
    })).rejects.toThrow(/state/);
    await expect(updateRoleSandboxState(options, "role", "nope" as never)).rejects.toThrow(/state/);
  });
});
