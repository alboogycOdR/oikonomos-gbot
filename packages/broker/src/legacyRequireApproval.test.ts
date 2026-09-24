import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  handlePreToolUse,
  type BrokerDependencies,
  type PreToolUseRequest,
  type RegisteredCapability,
} from "./index.js";

const request: PreToolUseRequest = {
  toolUseId: "legacy-require-approval-1",
  runId: "11111111-1111-1111-1111-111111111111",
  roleId: "office-manager",
  tenantId: "basileia",
  toolName: "mcp__workspace__send_to_role",
  input: { toRoleId: "trevor", message: "Please review the draft." },
  agentRef: { provider: "claude", sessionRef: "session-1", isSubagent: false },
};

function legacyCapability(overrides: Partial<RegisteredCapability> = {}): RegisteredCapability {
  return {
    toolName: request.toolName,
    capabilityId: "workspace.send_to_role",
    defaultTier: "T1_draft",
    ...overrides,
  };
}

function dependencies(overrides: Partial<BrokerDependencies> = {}): BrokerDependencies {
  return {
    isCapabilitiesEnabled: vi.fn(() => true),
    getCapability: vi.fn(async () => legacyCapability()),
    getRoleGrant: vi.fn(async () => ({ maxTier: "T4_irreversible" as const })),
    destinationFor: vi.fn(() => "trevor"),
    issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
    consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
    issueApproval: vi.fn(async () => ({
      reason: "approval_pending" as const,
      approvalId: "approval-1",
      nonce: "nonce-1",
      expiresAt: new Date("2026-09-25T00:01:00Z"),
      actionDigest: "a".repeat(64),
      actionRender: "send to role trevor",
      destination: "trevor",
      status: "pending" as const,
    })),
    verifyAndConsume: vi.fn(async () => ({ consumed: false as const, rowCount: 0 as const })),
    recordDecision: vi.fn(async () => ({ eventId: "audit-1" })),
    ...overrides,
  };
}

describe("handlePreToolUse — legacy Require-Approval rules", () => {
  it("parks a matching enabled rule through the existing approval path", async () => {
    const deps = dependencies({
      getRequireApprovalRules: vi.fn(async () => [{
        capabilityId: "workspace.send_to_role",
        enabled: true,
        targetPredicate: { toRoleId: "trevor" },
      }]),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "approval_pending",
      approvalId: "approval-1",
      auditEventId: "audit-1",
    });
    expect(deps.issueApproval).toHaveBeenCalledOnce();
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "require_approval",
      capability: "workspace.send_to_role",
    }));
  });

  it("keeps disabled and absent rules byte-for-byte autonomous", async () => {
    for (const rules of [
      [],
      [{ capabilityId: "workspace.send_to_role", enabled: false, targetPredicate: {} }],
    ]) {
      const deps = dependencies({ getRequireApprovalRules: vi.fn(async () => rules) });

      await expect(handlePreToolUse(request, deps)).resolves.toEqual({
        decision: "allow",
        tier: "T1_draft",
        auditEventId: "audit-1",
      });
      expect(deps.issueApproval).not.toHaveBeenCalled();
    }
  });

  it("does not promote a rule whose target predicate does not match", async () => {
    const deps = dependencies({
      getRequireApprovalRules: vi.fn(async () => [{
        capabilityId: "workspace.send_to_role",
        enabled: true,
        targetPredicate: { toRoleId: "someone-else" },
      }]),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toMatchObject({ decision: "allow" });
    expect(deps.issueApproval).not.toHaveBeenCalled();
  });

  it("keeps the ceiling and T4 denials ahead of rule reads", async () => {
    const rules = vi.fn(async () => [{
      capabilityId: "workspace.send_to_role",
      enabled: true,
      targetPredicate: {},
    }]);
    const ceilingDeps = dependencies({
      getRoleGrant: vi.fn(async () => ({ maxTier: "T0_observe" as const })),
      getRequireApprovalRules: rules,
    });
    await expect(handlePreToolUse(request, ceilingDeps)).resolves.toMatchObject({ reason: "role.tier_ceiling" });
    expect(rules).not.toHaveBeenCalled();

    const t4Deps = dependencies({
      getCapability: vi.fn(async () => legacyCapability({ defaultTier: "T4_irreversible" })),
      getRequireApprovalRules: rules,
    });
    await expect(handlePreToolUse(request, t4Deps)).resolves.toMatchObject({ reason: "tier.irreversible" });
    expect(rules).not.toHaveBeenCalled();
  });

  it("fails closed when legacy rule reads fail", async () => {
    const deps = dependencies({
      getRequireApprovalRules: vi.fn(async () => { throw new Error("rules unavailable"); }),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "broker.dependency_failure",
      auditEventId: "audit-1",
    });
    expect(deps.issueApproval).not.toHaveBeenCalled();
  });

  it("LIVENESS: removing the legacy matching-rule check allows this T1 action", async () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(source).toContain("matchesRequireApprovalRule(");

    const deps = dependencies({
      getRequireApprovalRules: vi.fn(async () => [{
        capabilityId: "workspace.send_to_role",
        enabled: true,
        targetPredicate: { toRoleId: "trevor" },
      }]),
    });
    const response = await handlePreToolUse(request, deps);
    expect(response).toMatchObject({ reason: "approval_pending" });
    expect(response.decision).not.toBe("allow");
  });
});
