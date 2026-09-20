import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
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
});
