import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimRoleSandboxForReap,
  createRole,
  defaultPoolConfig,
  getRoleSandbox,
  listRoleSandboxes,
  roleSandboxStates,
  updateRoleSandboxState,
  upsertRoleSandbox,
} from "./index.js";

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
    await expect(claimRoleSandboxForReap(options, {
      roleId: "role", sandboxId: "sandbox", state: "Paused", idleBefore: new Date("invalid"),
    })).rejects.toThrow(/idleBefore/);
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("listRoleSandboxes", () => {
  let pool: Pool;
  const options = { connectionString: connectionString! };

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM role_sandboxes WHERE role_id LIKE 'task-312-db-%'");
    await pool.query("DELETE FROM roles WHERE role_id LIKE 'task-312-db-%'");
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
  });
  afterAll(async () => { await cleanup(); await pool.end(); });

  it("lists offices from every tenant with the owning role status", async () => {
    await createRole(options, { roleId: "task-312-db-active", tenantId: "task-312-db-a", name: "A", title: "A" });
    await createRole(options, { roleId: "task-312-db-deleted", tenantId: "task-312-db-b", name: "B", title: "B", status: "deleted" });
    await upsertRoleSandbox(options, { roleId: "task-312-db-active", sandboxId: "task-312-a", state: "Paused", execdTokenRef: "secret://a" });
    await upsertRoleSandbox(options, { roleId: "task-312-db-deleted", sandboxId: "task-312-b", state: "Paused", execdTokenRef: "secret://b" });

    const rows = (await listRoleSandboxes(options)).filter((row) => row.roleId.startsWith("task-312-db-"));

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: "task-312-db-active", tenantId: "task-312-db-a", roleStatus: "active" }),
      expect.objectContaining({ roleId: "task-312-db-deleted", tenantId: "task-312-db-b", roleStatus: "deleted" }),
    ]));
  });

  it("does not claim an idle office after a concurrent turn refreshes its last-use time", async () => {
    const roleId = "task-312-db-race";
    await createRole(options, { roleId, tenantId: "task-312-db-race-tenant", name: "Race", title: "Race role" });
    await upsertRoleSandbox(options, { roleId, sandboxId: "task-312-race", state: "Paused", execdTokenRef: "secret://race" });
    await pool.query("UPDATE role_sandboxes SET last_used_at = now() - interval '10 days' WHERE role_id = $1", [roleId]);
    const selected = await getRoleSandbox(options, roleId);
    expect(selected).not.toBeNull();
    await updateRoleSandboxState(options, roleId, "Running");

    await expect(claimRoleSandboxForReap(options, {
      roleId,
      sandboxId: selected!.sandboxId,
      state: selected!.state,
      idleBefore: new Date(Date.now() - 3 * 24 * 60 * 60_000),
    })).resolves.toBeNull();
    expect((await getRoleSandbox(options, roleId))?.state).toBe("Running");
  });
});
