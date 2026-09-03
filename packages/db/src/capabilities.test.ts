import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createConnectorRegistrationStore,
  defaultPoolConfig,
  type ConnectorRegistrationRows,
} from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

describe("ConnectorRegistrationRows.adapter (TASK-113 / ADR-013 §4)", () => {
  function mockPoolClient() {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (text.startsWith("SELECT adapter")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    return { pool, client, queries };
  }

  it("defaults the persisted adapter to mcp:<connectorId> when rows.adapter is omitted", async () => {
    const { pool, queries } = mockPoolClient();
    const store = createConnectorRegistrationStore(pool);
    const rows: ConnectorRegistrationRows = {
      connectorId: "gmail",
      capabilities: [
        { capabilityId: "gmail.read", description: "read", defaultTier: "T0_observe", enabled: true },
      ],
      roleGrants: [],
    };

    await store.register(rows);

    const insert = queries.find((q) => q.text.includes("INSERT INTO capabilities"));
    expect(insert?.values).toEqual(["gmail.read", "read", "T0_observe", "mcp:gmail", true]);
  });

  it("passes rows.adapter through unchanged when supplied", async () => {
    const { pool, queries } = mockPoolClient();
    const store = createConnectorRegistrationStore(pool);
    const rows: ConnectorRegistrationRows = {
      connectorId: "builtins",
      adapter: "sdk:builtin",
      capabilities: [
        { capabilityId: "fs.read", description: "read", defaultTier: "T0_observe", enabled: true },
      ],
      roleGrants: [],
    };

    await store.register(rows);

    const insert = queries.find((q) => q.text.includes("INSERT INTO capabilities"));
    expect(insert?.values).toEqual(["fs.read", "read", "T0_observe", "sdk:builtin", true]);
  });
});

function fixture(connectorId: string): ConnectorRegistrationRows {
  const capabilityId = `task-044.${connectorId}.read`;
  return {
    connectorId,
    capabilities: [{
      capabilityId,
      description: `TASK-044 ${connectorId} read fixture.`,
      defaultTier: "T0_observe",
      enabled: false,
    }],
    roleGrants: [{
      roleId: "inbox-triage",
      capabilityId,
      maxTier: "T1_draft",
      constraints: { domains: ["*"] },
    }],
  };
}

integration("connector registration persistence (TASK-044 / OIK-048)", () => {
  let pool: Pool;
  let store: ReturnType<typeof createConnectorRegistrationStore>;
  const alpha = fixture("alpha");
  const beta = fixture("beta");

  async function snapshot(connectorId: string): Promise<unknown> {
    const adapter = `mcp:${connectorId}`;
    const capabilities = await pool.query(
      `SELECT capability_id, description, default_tier, adapter, enabled
       FROM capabilities WHERE adapter = $1 ORDER BY capability_id`,
      [adapter],
    );
    const grants = await pool.query(
      `SELECT role_id, capability_id, max_tier, constraints
       FROM role_grants WHERE capability_id IN (
         SELECT capability_id FROM capabilities WHERE adapter = $1
       ) ORDER BY role_id, capability_id`,
      [adapter],
    );
    return { capabilities: capabilities.rows, grants: grants.rows };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    store = createConnectorRegistrationStore(pool);
    await store.deregister(alpha.connectorId);
    await store.deregister(beta.connectorId);
  });

  afterAll(async () => {
    await store.deregister(alpha.connectorId);
    await store.deregister(beta.connectorId);
    await pool.end();
  });

  it("uses full snapshots for idempotency and persists disabled capabilities", async () => {
    await store.register(alpha);
    const first = await snapshot(alpha.connectorId);
    await store.register(alpha);

    expect(await snapshot(alpha.connectorId)).toEqual(first);
    expect(first).toMatchObject({
      capabilities: [{ capability_id: "task-044.alpha.read", enabled: false }],
    });
  });

  it("deregisters only one connector and leaves the other byte-identical", async () => {
    await store.register(alpha);
    await store.register(beta);
    const betaBefore = JSON.stringify(await snapshot(beta.connectorId));

    await store.deregister(alpha.connectorId);

    expect(await snapshot(alpha.connectorId)).toEqual({ capabilities: [], grants: [] });
    expect(JSON.stringify(await snapshot(beta.connectorId))).toBe(betaBefore);
  });
});
