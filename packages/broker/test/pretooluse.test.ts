import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  approvalOperations,
  handlePreToolUse,
  type BrokerDependencies,
  type PreToolUseRequest,
  type RegisteredCapability,
} from "../src/index.js";
import { issueApproval, verifyAndConsume } from "@oikonomos/approvals";

const request: PreToolUseRequest = {
  toolUseId: "tool-use-1",
  runId: "11111111-1111-1111-1111-111111111111",
  roleId: "inbox-triage",
  tenantId: "basileia",
  toolName: "mcp__gmail__create_draft",
  input: { to: "review@example.test", subject: "Quarterly review" },
  agentRef: { provider: "codex", sessionRef: "session-1", isSubagent: false },
};

function capability(overrides: Partial<RegisteredCapability> = {}): RegisteredCapability {
  return {
    toolName: request.toolName,
    capabilityId: "email.create_draft",
    defaultTier: "T1_draft",
    ...overrides,
  };
}

function dependencies(overrides: Partial<BrokerDependencies> = {}): BrokerDependencies {
  return {
    getCapability: vi.fn(async () => capability()),
    getRoleGrant: vi.fn(async () => ({ maxTier: "T3_external" })),
    destinationFor: vi.fn(() => "review@example.test"),
    issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
    consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
    issueApproval: vi.fn(async () => ({
      reason: "approval_pending",
      approvalId: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      actionDigest: "a".repeat(64),
      actionRender: "derived downstream",
      destination: "review@example.test",
      status: "pending",
    })),
    verifyAndConsume: vi.fn(async () => ({ consumed: false, rowCount: 0 })),
    recordDecision: vi.fn(async () => ({ eventId: "42" })),
    ...overrides,
  };
}

describe("handlePreToolUse — Handover §4.1", () => {
  it("returns the allow shape and audits a low-tier request", async () => {
    const deps = dependencies();

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "allow",
      tier: "T1_draft",
      auditEventId: "42",
    });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "allow",
      capability: "email.create_draft",
      runId: request.runId,
      tenantId: "basileia",
    }));
  });

  it("denies and audits an unregistered tool", async () => {
    const deps = dependencies({ getCapability: vi.fn(async () => null) });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "capability.unregistered",
      auditEventId: "42",
    });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "deny",
      reason: "capability.unregistered",
    }));
  });

  it("issues approval without composing or passing an approval render", async () => {
    const deps = dependencies({
      getCapability: vi.fn(async () => capability({
        capabilityId: "email.send",
        toolName: "mcp__gmail__send_message",
        defaultTier: "T3_external",
      })),
    });
    const tierThreeRequest = { ...request, toolName: "mcp__gmail__send_message" };

    const response = await handlePreToolUse(tierThreeRequest, deps);

    expect(response).toMatchObject({
      decision: "deny",
      reason: "approval_pending",
      approvalId: expect.any(String),
      auditEventId: "42",
    });
    expect(deps.issueApproval).toHaveBeenCalledWith(
      {
        runId: request.runId,
        capabilityId: "email.send",
        toolName: "mcp__gmail__send_message",
        input: request.input,
        destination: "review@example.test",
        tenantId: "basileia",
      },
      deps.issueApprovalDependencies,
    );
    expect(deps.issueApproval).not.toHaveBeenCalledWith(expect.objectContaining({ actionRender: expect.anything() }));
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ verdict: "require_approval" }));
  });

  it("allows an approved retry only through @oikonomos/approvals' consume port", async () => {
    const deps = dependencies({
      getCapability: vi.fn(async () => capability({ defaultTier: "T3_external" })),
      verifyAndConsume: vi.fn(async () => ({
        consumed: true,
        rowCount: 1,
        approval: {} as never,
      })),
    });

    await expect(handlePreToolUse({ ...request, approvalNonce: randomUUID() }, deps)).resolves.toEqual({
      decision: "allow",
      tier: "T3_external",
      auditEventId: "42",
    });
    expect(deps.verifyAndConsume).toHaveBeenCalledOnce();
    expect(deps.verifyAndConsume).toHaveBeenCalledWith(
      expect.any(String),
      deps.consumeDependencies,
      expect.objectContaining({ toolName: request.toolName }),
    );
  });

  it("denies and audits a rejected approval nonce", async () => {
    const deps = dependencies({ getCapability: vi.fn(async () => capability({ defaultTier: "T3_external" })) });

    await expect(handlePreToolUse({ ...request, approvalNonce: randomUUID() }, deps)).resolves.toEqual({
      decision: "deny",
      reason: "approval.not_granted",
      auditEventId: "42",
    });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ verdict: "deny" }));
  });

  it("denies a T3 capability when the persisted max_tier ceiling is T1 (ADR-003)", async () => {
    const deps = dependencies({
      getCapability: vi.fn(async () => capability({ defaultTier: "T3_external" })),
      getRoleGrant: vi.fn(async () => ({ maxTier: "T1_draft" })),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "role.tier_ceiling",
      auditEventId: "42",
    });
    expect(deps.issueApproval).not.toHaveBeenCalled();
  });

  it("denies and audits a capability with no matching role grant", async () => {
    const deps = dependencies({ getRoleGrant: vi.fn(async () => null) });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "role.grant_missing",
      auditEventId: "42",
    });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ verdict: "deny" }));
  });

  it("denies and audits irreversible T4 actions even with a granted nonce", async () => {
    const deps = dependencies({
      getCapability: vi.fn(async () => capability({ defaultTier: "T4_irreversible" })),
      getRoleGrant: vi.fn(async () => ({ maxTier: "T4_irreversible" })),
      verifyAndConsume: vi.fn(async () => ({ consumed: true, rowCount: 1, approval: {} as never })),
    });

    await expect(handlePreToolUse({ ...request, approvalNonce: randomUUID() }, deps)).resolves.toEqual({
      decision: "deny",
      reason: "tier.irreversible",
      auditEventId: "42",
    });
    expect(deps.verifyAndConsume).not.toHaveBeenCalled();
  });

  it("binds the concrete approval ports to the genuine exports", () => {
    expect(approvalOperations.issueApproval).toBe(issueApproval);
    expect(approvalOperations.verifyAndConsume).toBe(verifyAndConsume);
  });
});
