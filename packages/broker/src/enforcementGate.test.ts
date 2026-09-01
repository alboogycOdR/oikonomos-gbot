import { describe, expect, it, vi } from "vitest";

import { resolveEnforcementGate } from "./enforcementGate.js";
import {
  handlePreToolUse,
  type BrokerDependencies,
  type PreToolUseRequest,
  type RegisteredCapability,
} from "./index.js";
import { RefusalMemory } from "./refusalMemory.js";
import type { JsonValue } from "@oikonomos/shared";

const input = {
  capabilityId: "email.send",
  target: { to: "operator@example.test" },
  actionClasses: [],
  requireApprovalRules: [],
  refusalMemoryHit: false,
  roleGrantCeilingExceeded: false,
} as const;

describe("resolveEnforcementGate — Addendum F §5.4", () => {
  it("keeps the policy resolver's autonomous default and deciding rank", () => {
    expect(resolveEnforcementGate(input)).toEqual({
      enforcementClass: "autonomous",
      rank: 6,
      reason: "default_autonomous",
    });
  });

  it("cannot let an allow rule relax a fixed-floor payment action", () => {
    expect(resolveEnforcementGate({ ...input, actionClasses: ["E1_payment"] })).toMatchObject({
      enforcementClass: "enforced",
      rank: 2,
    });
  });

  it("keeps remembered denials ahead of later grant widening", () => {
    expect(resolveEnforcementGate({
      ...input,
      refusalMemoryHit: true,
      roleGrantCeilingExceeded: false,
    })).toEqual({ enforcementClass: "denied", rank: 4, reason: "refusal_memory" });
  });
});

const request: PreToolUseRequest = {
  toolUseId: "enforcement-gate-1",
  runId: "11111111-1111-1111-1111-111111111111",
  roleId: "office-manager",
  tenantId: "basileia",
  toolName: "mcp__office__act",
  input: { target: "invoice-42" },
  agentRef: { provider: "claude", sessionRef: "session-1", isSubagent: false },
};

function capability(overrides: Partial<RegisteredCapability> = {}): RegisteredCapability {
  return {
    toolName: request.toolName,
    capabilityId: "office.act",
    defaultTier: "T1_draft",
    enforcementEnabled: true,
    enforcedActionClasses: [],
    ...overrides,
  };
}

function dependencies(overrides: Partial<BrokerDependencies> = {}): BrokerDependencies {
  return {
    isCapabilitiesEnabled: vi.fn(() => true),
    getCapability: vi.fn(async () => capability()),
    getRoleGrant: vi.fn(async () => ({ maxTier: "T4_irreversible" as const })),
    destinationFor: vi.fn(() => "invoice-42"),
    issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
    consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
    issueApproval: vi.fn(async () => ({
      reason: "approval_pending" as const,
      approvalId: "approval-1",
      nonce: "nonce-1",
      expiresAt: new Date("2026-09-01T00:01:00Z"),
      actionDigest: "a".repeat(64),
      actionRender: "payment invoice-42",
      destination: "invoice-42",
      status: "pending" as const,
    })),
    verifyAndConsume: vi.fn(async () => ({ consumed: false as const, rowCount: 0 as const })),
    recordDecision: vi.fn(async () => ({ eventId: "audit-1" })),
    ...overrides,
  };
}

describe("handlePreToolUse — enforcement gate is on the L1 execution path", () => {
  it("executes autonomous actions and audits both class and deciding rank", async () => {
    const deps = dependencies({
      getCapability: vi.fn(async () => capability({ defaultTier: "T4_irreversible" })),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "allow",
      tier: "T4_irreversible",
      auditEventId: "audit-1",
    });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "allow",
      payload: expect.objectContaining({ enforcementClass: "autonomous", enforcementRank: 6 }),
    }));
  });

  it("parks an E1 payment with the existing nonce-bound approval path", async () => {
    const deps = dependencies({
      getCapability: vi.fn(async () => capability({ enforcedActionClasses: ["E1_payment"] })),
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
      payload: expect.objectContaining({ enforcementClass: "enforced", enforcementRank: 2 }),
    }));
  });

  it("routes E2 auth friction to human takeover and never issues approval", async () => {
    const deps = dependencies({
      getCapability: vi.fn(async () => capability({
        enforcedActionClasses: ["E2_auth_security_friction"],
      })),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "human.takeover",
      auditEventId: "audit-1",
    });
    expect(deps.issueApproval).not.toHaveBeenCalled();
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      reason: "human.takeover",
      payload: expect.objectContaining({ takeover: true }),
    }));
  });

  it("uses the existing fail-closed path for a malformed capability", async () => {
    const deps = dependencies({ getCapability: vi.fn(async () => ({ capabilityId: "broken" } as never)) });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "broker.malformed_response",
      auditEventId: "audit-1",
    });
    expect(deps.issueApproval).not.toHaveBeenCalled();
  });

  it("auto-denies refusal memory before an approval can be issued, even after widening", async () => {
    const memory = new RefusalMemory();
    memory.rememberDenial({ runId: request.runId, tool: request.toolName, target: request.input as JsonValue });
    memory.widenGrants();
    expect(memory.consult({ runId: request.runId, tool: request.toolName, target: request.input as JsonValue }))
      .toMatchObject({ decision: "deny", code: "refusal.abandoned" });
    const deps = dependencies({
      refusalMemory: memory,
      getCapability: vi.fn(async () => capability({ enforcedActionClasses: ["E1_payment"] })),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "refusal.abandoned",
      auditEventId: "audit-1",
    });
    expect(deps.issueApproval).not.toHaveBeenCalled();
  });

  it("LIVENESS: bypassing the gate lets a formerly parked payment execute", async () => {
    const gateOn = dependencies({
      getCapability: vi.fn(async () => capability({ enforcedActionClasses: ["E1_payment"] })),
    });
    await expect(handlePreToolUse(request, gateOn)).resolves.toMatchObject({ reason: "approval_pending" });

    const bypassed = dependencies({
      getCapability: vi.fn(async () => capability({
        enforcementEnabled: false,
        enforcedActionClasses: ["E1_payment"],
      })),
    });
    await expect(handlePreToolUse(request, bypassed)).resolves.toMatchObject({ decision: "allow" });
  });
});
