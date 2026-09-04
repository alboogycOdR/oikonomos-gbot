import { handlePreToolUse, type BrokerDependencies, CapabilityRegistry } from "@oikonomos/broker";
import { Database, defaultPoolConfig } from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

const roleId = "task-140-kill-switch-drill-role";
const tenantId = "task-140-kill-switch-drill";
const capabilityA = "task-140.kill-switch.a";
const capabilityB = "task-140.kill-switch.b";
const toolA = "mcp__task_140_kill_switch__read_a";
const toolB = "mcp__task_140_kill_switch__read_b";
const adapter = "mcp:task-140-kill-switch";

integration("capability kill-switch drill (TASK-140 / OIK-112)", () => {
  let pool: Pool;
  let database: Database;

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM role_grants WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM capabilities WHERE capability_id = ANY($1)`, [[capabilityA, capabilityB]]);
    await pool.query(`DELETE FROM roles WHERE role_id = $1`, [roleId]);
  }

  async function seed(): Promise<void> {
    await cleanup();
    await pool.query(
      `INSERT INTO roles (role_id, tenant_id, name, title, description, status)
       VALUES ($1, $2, 'TASK-140 drill', 'TASK-140 drill', 'fixture', 'active')`,
      [roleId, tenantId],
    );
    for (const capabilityId of [capabilityA, capabilityB]) {
      await database.upsertCapability({
        capabilityId,
        description: "TASK-140 kill-switch drill fixture",
        defaultTier: "T0_observe",
        adapter,
        enabled: true,
      });
      await database.upsertRoleGrant({ roleId, capabilityId, maxTier: "T1_draft", constraints: {} });
    }
  }

  async function dependencies(): Promise<BrokerDependencies> {
    const registry = await CapabilityRegistry.build({
      declared: [
        { toolName: toolA, capabilityId: capabilityA, defaultTier: "T0_observe", adapter, enabled: true, mcpServerName: "task_140_kill_switch" },
        { toolName: toolB, capabilityId: capabilityB, defaultTier: "T0_observe", adapter, enabled: true, mcpServerName: "task_140_kill_switch" },
      ],
      persisted: database,
    });
    return {
      isCapabilitiesEnabled: () => true,
      ...registry.brokerPorts(database),
      destinationFor: () => "task-140-drill-target",
      issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
      consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
      issueApproval: vi.fn(),
      verifyAndConsume: vi.fn(),
      recordDecision: vi.fn(async () => ({ eventId: "task-140-audit" })),
      manifestMap: registry.enabledToolNames,
    };
  }

  function request(toolName: string, toolUseId: string) {
    return {
      toolUseId,
      runId: "11111111-1111-1111-1111-111111111140",
      roleId,
      tenantId,
      toolName,
      input: {},
      agentRef: { provider: "test", sessionRef: "task-140", isSubagent: false },
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    database = new Database({ connectionString: connectionString! });
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    await database.close();
  });

  it("allows, then immediately denies after a single-capability DB flip using the same dependencies", async () => {
    await seed();
    const deps = await dependencies();

    await expect(handlePreToolUse(request(toolA, "task-140-single-before"), deps)).resolves.toMatchObject({ decision: "allow" });
    await expect(database.setCapabilityEnabled(capabilityA, false)).resolves.toMatchObject({ enabled: false });
    await expect(handlePreToolUse(request(toolA, "task-140-single-after"), deps)).resolves.toMatchObject({
      decision: "deny",
      reason: "capability.unregistered",
    });
    await expect(handlePreToolUse(request(toolB, "task-140-single-other"), deps)).resolves.toMatchObject({ decision: "allow" });
  });

  it("allows, then immediately denies every registered tool after the platform-wide DB flip", async () => {
    await seed();
    const deps = await dependencies();
    const before = await database.listCapabilities();

    try {
      await expect(handlePreToolUse(request(toolA, "task-140-all-before"), deps)).resolves.toMatchObject({ decision: "allow" });
      await expect(database.setAllCapabilitiesEnabled(false)).resolves.toBeGreaterThanOrEqual(2);
      await expect(handlePreToolUse(request(toolA, "task-140-all-after-a"), deps)).resolves.toMatchObject({
        decision: "deny",
        reason: "capability.unregistered",
      });
      await expect(handlePreToolUse(request(toolB, "task-140-all-after-b"), deps)).resolves.toMatchObject({
        decision: "deny",
        reason: "capability.unregistered",
      });
    } finally {
      await Promise.all(before.map((capability) =>
        database.setCapabilityEnabled(capability.capabilityId, capability.enabled),
      ));
    }
  });
});
