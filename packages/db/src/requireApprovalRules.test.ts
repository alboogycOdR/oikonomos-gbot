import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRequireApprovalRule,
  createRole,
  defaultPoolConfig,
  getRequireApprovalRule,
  listRequireApprovalRules,
  setAutoReviewEnabled,
  setRequireApprovalRuleEnabled,
  syncAutoReviewForGrant,
} from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db requireApprovalRules — read + CRUD + FK (TASK-084)", () => {
  let pool: Pool;
  const tenantId = "task-084-rules-suite";
  const roleId = "task-084-rules-suite-role";
  const capabilityId = "task-084-rules-suite-cap";
  const riskyCapabilityId = "task-350-rules-suite-risk";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM require_approval_rules WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM roles WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM capabilities WHERE capability_id = $1`, [capabilityId]);
    await pool.query(`DELETE FROM capabilities WHERE capability_id = $1`, [riskyCapabilityId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await pool.query(
      `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled)
       VALUES ($1, 'd', 'T0_observe', 'x', true)`,
      [capabilityId],
    );
    await pool.query(
      `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled)
       VALUES ($1, 'risky', 'T1_draft', 'x', true)`,
      [riskyCapabilityId],
    );
    await createRole(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Rules Suite", title: "Rules Suite Role" },
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("creates a whole-tenant rule (roleId null) and reads it back byte-identical", async () => {
    const created = await createRequireApprovalRule(
      { connectionString: connectionString! },
      { tenantId, capabilityId, targetPredicate: { destination: "external" } },
    );

    expect(created.roleId).toBeNull();
    expect(created.enabled).toBe(true);

    const fetched = await getRequireApprovalRule(
      { connectionString: connectionString! },
      created.ruleId,
    );
    expect(fetched).toEqual(created);
  });

  it("creates a role-scoped rule", async () => {
    const created = await createRequireApprovalRule(
      { connectionString: connectionString! },
      { tenantId, roleId, capabilityId },
    );
    expect(created.roleId).toBe(roleId);
  });

  it("getRequireApprovalRule returns null for an unknown ruleId", async () => {
    const result = await getRequireApprovalRule(
      { connectionString: connectionString! },
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });

  it("F15: capability_id FK rejects a rule referencing a capability that does not exist", async () => {
    await expect(
      createRequireApprovalRule(
        { connectionString: connectionString! },
        { tenantId, capabilityId: "task-084-rules-suite-nonexistent-cap" },
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("F15: role_id FK rejects a rule referencing a role that does not exist", async () => {
    await expect(
      createRequireApprovalRule(
        { connectionString: connectionString! },
        { tenantId, roleId: "task-084-rules-suite-nonexistent-role", capabilityId },
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("listRequireApprovalRules: roleId:null filters to whole-tenant rules only; omitting roleId returns both", async () => {
    await pool.query(`DELETE FROM require_approval_rules WHERE tenant_id = $1`, [tenantId]);
    const tenantWide = await createRequireApprovalRule(
      { connectionString: connectionString! },
      { tenantId, capabilityId },
    );
    const roleScoped = await createRequireApprovalRule(
      { connectionString: connectionString! },
      { tenantId, roleId, capabilityId },
    );

    const wholeTenantOnly = await listRequireApprovalRules(
      { connectionString: connectionString! },
      { tenantId, roleId: null },
    );
    expect(wholeTenantOnly.map((r) => r.ruleId)).toEqual([tenantWide.ruleId]);

    const all = await listRequireApprovalRules({ connectionString: connectionString! }, { tenantId });
    expect(all.map((r) => r.ruleId).sort()).toEqual(
      [tenantWide.ruleId, roleScoped.ruleId].sort(),
    );
  });

  it("TASK-350 Auto-review creates/re-enables only risky granted rules and preserves manual rules", async () => {
    await pool.query(`DELETE FROM require_approval_rules WHERE tenant_id = $1`, [tenantId]);
    await pool.query(
      `INSERT INTO role_grants (role_id, capability_id, max_tier, constraints)
       VALUES ($1, $2, 'T1_draft', '{}'::jsonb)`,
      [roleId, riskyCapabilityId],
    );
    const manual = await createRequireApprovalRule(
      { connectionString: connectionString! },
      { tenantId, roleId, capabilityId, createdBy: "manual" },
    );
    await setAutoReviewEnabled({ connectionString: connectionString! }, { tenantId, roleId, enabled: true });
    let rules = await listRequireApprovalRules({ connectionString: connectionString! }, { tenantId, roleId });
    expect(rules.filter((rule) => rule.createdBy === "auto-review").map((rule) => rule.capabilityId)).toEqual([riskyCapabilityId]);
    await setAutoReviewEnabled({ connectionString: connectionString! }, { tenantId, roleId, enabled: false });
    rules = await listRequireApprovalRules({ connectionString: connectionString! }, { tenantId, roleId });
    expect(rules.find((rule) => rule.ruleId === manual.ruleId)?.enabled).toBe(true);
    expect(rules.find((rule) => rule.createdBy === "auto-review")?.enabled).toBe(false);
    await expect(setRequireApprovalRuleEnabled({ connectionString: connectionString! }, { tenantId: "other", roleId, ruleId: manual.ruleId, enabled: false })).resolves.toBeNull();
    await syncAutoReviewForGrant({ connectionString: connectionString! }, { tenantId, roleId, capabilityId: riskyCapabilityId });
    expect((await listRequireApprovalRules({ connectionString: connectionString! }, { tenantId, roleId })).filter((rule) => rule.createdBy === "auto-review")).toHaveLength(1);
  });

  it("listRequireApprovalRules enabledOnly excludes disabled rules", async () => {
    await pool.query(`DELETE FROM require_approval_rules WHERE tenant_id = $1`, [tenantId]);
    const enabled = await createRequireApprovalRule(
      { connectionString: connectionString! },
      { tenantId, capabilityId, enabled: true },
    );
    await createRequireApprovalRule(
      { connectionString: connectionString! },
      { tenantId, capabilityId, enabled: false },
    );

    const onlyEnabled = await listRequireApprovalRules(
      { connectionString: connectionString! },
      { tenantId, enabledOnly: true },
    );
    expect(onlyEnabled.map((r) => r.ruleId)).toEqual([enabled.ruleId]);
  });
});
