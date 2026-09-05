import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { BUILTIN_TOOLS } from "@oikonomos/broker";
import {
  createConnectorRegistrationStore,
  defaultPoolConfig,
  type ConnectorRegistrationRows,
  type ConnectorRegistrationStore,
} from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerCapabilities } from "./registerCapabilities.js";

class RecordingStore implements ConnectorRegistrationStore {
  readonly registrations: ConnectorRegistrationRows[] = [];

  async register(rows: ConnectorRegistrationRows): Promise<void> {
    this.registrations.push(rows);
  }

  async deregister(): Promise<void> {}
}

describe("registerCapabilities", () => {
  it("registers each loaded manifest and the zero-grant built-in declaration set", async () => {
    const store = new RecordingStore();
    await registerCapabilities({ store });

    expect(store.registrations.map((rows) => rows.connectorId)).toEqual([
      "gmail",
      "google-calendar",
      "google-drive",
      "builtins",
      "workspace",
    ]);
    const builtins = store.registrations.find((rows) => rows.connectorId === "builtins");
    expect(builtins).toMatchObject({ adapter: "sdk:builtin", roleGrants: [] });
    expect(builtins?.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: "fs.read", defaultTier: "T0_observe" }),
      expect.objectContaining({ capabilityId: "fs.write", defaultTier: "T2_internal" }),
      expect.objectContaining({ capabilityId: "runtime.bash", defaultTier: "T3_external" }),
    ]));
    expect(builtins?.capabilities).toHaveLength(new Set(BUILTIN_TOOLS.filter((tool) => tool.adapter === "sdk:builtin").map((tool) => tool.capabilityId)).size);
    expect(store.registrations.find((rows) => rows.connectorId === "workspace")).toMatchObject({
      adapter: "mcp:workspace",
      roleGrants: [],
      capabilities: [
        expect.objectContaining({ capabilityId: "workspace.send_to_role", defaultTier: "T1_draft" }),
        expect.objectContaining({ capabilityId: "workspace.rename_self", defaultTier: "T1_draft" }),
      ],
    });
  });

  it("is never called from a service process entrypoint", async () => {
    const workerIndex = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const controlApiIndex = await readFile(
      fileURLToPath(new URL("../../control-api/src/index.ts", import.meta.url)),
      "utf8",
    );
    expect(workerIndex).not.toMatch(/registerCapabilities/);
    expect(controlApiIndex).not.toMatch(/registerCapabilities|register-capabilities/);
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("registerCapabilities PostgreSQL idempotency", () => {
  let pool: Pool;
  let fixturePool: Pool;
  let store: ReturnType<typeof createConnectorRegistrationStore>;
  const schema = `task_151_register_capabilities_${crypto.randomUUID().replaceAll("-", "")}`;

  async function snapshot(): Promise<unknown> {
    const result = await pool.query(
      `SELECT capability_id, description, default_tier, adapter, enabled
       FROM capabilities
       WHERE adapter IN ('mcp:gmail', 'mcp:google-calendar', 'mcp:google-drive', 'sdk:builtin', 'mcp:workspace')
       ORDER BY adapter, capability_id`,
    );
    const grants = await pool.query(
      `SELECT role_id, capability_id, max_tier, constraints
       FROM role_grants
       WHERE capability_id IN (
         SELECT capability_id FROM capabilities
         WHERE adapter IN ('mcp:gmail', 'mcp:google-calendar', 'mcp:google-drive', 'sdk:builtin', 'mcp:workspace')
       )
       ORDER BY role_id, capability_id`,
    );
    return { capabilities: result.rows, grants: grants.rows };
  }

  beforeAll(async () => {
    // This declaration inventory uses the real fixed manifest IDs. Keep it in
    // a disposable schema so concurrent integration fixtures cannot overwrite
    // those rows with their own descriptions while the byte-identical check is
    // in progress.
    fixturePool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await fixturePool.query(`CREATE SCHEMA ${schema}`);
    await fixturePool.query(`CREATE TABLE ${schema}.roles (LIKE public.roles INCLUDING ALL)`);
    await fixturePool.query(`CREATE TABLE ${schema}.capabilities (LIKE public.capabilities INCLUDING ALL)`);
    await fixturePool.query(`CREATE TABLE ${schema}.role_grants (LIKE public.role_grants INCLUDING ALL)`);
    await fixturePool.query(
      `ALTER TABLE ${schema}.role_grants
       ADD CONSTRAINT role_grants_role_id_fkey
       FOREIGN KEY (role_id) REFERENCES ${schema}.roles(role_id)`,
    );
    await fixturePool.query(
      `ALTER TABLE ${schema}.role_grants
       ADD CONSTRAINT role_grants_capability_id_fkey
       FOREIGN KEY (capability_id) REFERENCES ${schema}.capabilities(capability_id)`,
    );

    pool = new Pool({
      connectionString: connectionString!,
      ...defaultPoolConfig,
      options: `-c search_path=${schema},public`,
    });
    store = createConnectorRegistrationStore(pool);
    // Connector registration correctly relies on D0 roles already existing.
    // Seed the three manifest-declared identities, idempotently, for this
    // real-Postgres registration test; production registration never does this.
    for (const roleId of ["inbox-triage", "calendar-assistant", "drive-assistant"]) {
      await pool.query(
        `INSERT INTO roles (role_id, tenant_id, name, title, description, status)
         VALUES ($1, 'basileia', $1, $1, 'TASK-114 registration integration fixture', 'active')
         ON CONFLICT (role_id) DO NOTHING`,
        [roleId],
      );
    }
  });

  afterAll(async () => {
    await pool.end();
    await fixturePool.query(`DROP SCHEMA ${schema} CASCADE`);
    await fixturePool.end();
  });

  it("leaves the complete declaration inventory byte-identical on a second registration", async () => {
    await registerCapabilities({ store });
    const first = await snapshot();
    await registerCapabilities({ store });
    expect(await snapshot()).toEqual(first);
    expect(first).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({ adapter: "mcp:gmail" }),
        expect.objectContaining({ adapter: "mcp:google-calendar" }),
        expect.objectContaining({ adapter: "mcp:google-drive" }),
        expect.objectContaining({ adapter: "sdk:builtin", capability_id: "runtime.bash" }),
        expect.objectContaining({ adapter: "mcp:workspace", capability_id: "workspace.send_to_role", default_tier: "T1_draft" }),
        expect.objectContaining({ adapter: "mcp:workspace", capability_id: "workspace.rename_self", default_tier: "T1_draft" }),
      ]),
    });
  });
});
