import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  approvalOperations,
  BrokerFailure,
  handlePreToolUse,
  type BrokerDependencies,
  type PreToolUseRequest,
  type RegisteredCapability,
} from "../src/index.js";
import { issueApproval, verifyAndConsume, type IssueApprovalDependencies } from "@oikonomos/approvals";

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
    isCapabilitiesEnabled: vi.fn(() => true),
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
  it("replays one decision and one audit event when L1 and L3 share a toolUseId", async () => {
    const deps = dependencies();
    const first = handlePreToolUse(request, deps);
    const second = handlePreToolUse({ ...request, agentRef: { ...request.agentRef, isSubagent: true } }, deps);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { decision: "allow", tier: "T1_draft", auditEventId: "42" },
      { decision: "allow", tier: "T1_draft", auditEventId: "42" },
    ]);
    expect(deps.getCapability).toHaveBeenCalledOnce();
    expect(deps.recordDecision).toHaveBeenCalledOnce();
  });

  it("does not replay an allowed decision across roles or tenants", async () => {
    const deps = dependencies({
      getRoleGrant: vi.fn(async (roleId) => roleId === request.roleId ? { maxTier: "T3_external" } : null),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toMatchObject({ decision: "allow" });
    await expect(handlePreToolUse({
      ...request,
      roleId: "attacker-role",
      tenantId: "other-tenant",
    }, deps)).resolves.toEqual({
      decision: "deny",
      reason: "role.grant_missing",
      auditEventId: "42",
    });

    expect(deps.getRoleGrant).toHaveBeenCalledTimes(2);
    expect(deps.recordDecision).toHaveBeenCalledTimes(2);
  });

  it("stops replaying a decision after the hook timeout window", async () => {
    vi.useFakeTimers();
    try {
      const enabled = vi.fn(() => true);
      const deps = dependencies({ isCapabilitiesEnabled: enabled });

      await expect(handlePreToolUse(request, deps)).resolves.toMatchObject({ decision: "allow" });
      enabled.mockReturnValue(false);
      vi.advanceTimersByTime(10_001);

      await expect(handlePreToolUse(request, deps)).resolves.toEqual({
        decision: "deny",
        reason: "capability.disabled",
        auditEventId: "42",
      });
      expect(deps.recordDecision).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the capability kill switch for every new tool use without a restart", async () => {
    const enabled = vi.fn(() => true);
    const deps = dependencies({ isCapabilitiesEnabled: enabled });

    await expect(handlePreToolUse(request, deps)).resolves.toMatchObject({ decision: "allow" });
    enabled.mockReturnValue(false);
    await expect(handlePreToolUse({ ...request, toolUseId: "tool-use-2" }, deps)).resolves.toEqual({
      decision: "deny",
      reason: "capability.disabled",
      auditEventId: "42",
    });
    expect(enabled).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["typed timeout signal", new BrokerFailure("broker.timeout"), "broker.timeout"],
    ["HTTP 500", new BrokerFailure("broker.http_500"), "broker.http_500"],
  ])("fails closed and audits a %s", async (_case, error, reason) => {
    const deps = dependencies({ getCapability: vi.fn(async () => { throw error; }) });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({ decision: "deny", reason, auditEventId: "42" });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ verdict: "deny", reason }));
  });

  it("fails closed and audits a malformed broker body", async () => {
    const deps = dependencies({ getCapability: vi.fn(async () => ({}) as never) });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "broker.malformed_response",
      auditEventId: "42",
    });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ verdict: "deny" }));
  });

  it.each(["getCapability", "getRoleGrant"] as const)("fails closed and audits a %s dependency throw", async (dependency) => {
    const deps = dependencies({ [dependency]: vi.fn(async () => { throw new Error("database unavailable"); }) });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "broker.dependency_failure",
      auditEventId: "42",
    });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ verdict: "deny" }));
  });

  it("fails closed and audits a verifyAndConsume dependency throw", async () => {
    const deps = dependencies({
      getCapability: vi.fn(async () => capability({ defaultTier: "T3_external" })),
      verifyAndConsume: vi.fn(async () => { throw new Error("database unavailable"); }),
    });

    await expect(handlePreToolUse({ ...request, approvalNonce: randomUUID() }, deps)).resolves.toEqual({
      decision: "deny", reason: "broker.dependency_failure", auditEventId: "42",
    });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ verdict: "deny" }));
  });

  it("denies without rejecting when recordDecision fails; no same-path audit is possible", async () => {
    const deps = dependencies({ recordDecision: vi.fn(async () => { throw new Error("audit database unavailable"); }) });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny", reason: "audit.write_failed", auditEventId: "unavailable",
    });
    expect(deps.recordDecision).toHaveBeenCalledOnce();
  });

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

  it("rejects a payload-mutated approval through the real issue and consume ports", async () => {
    let row: Awaited<ReturnType<typeof issueApproval>> extends infer _Signal ? {
      approvalId: string; tenantId: string; runId: string; capabilityId: string; actionDigest: Buffer;
      actionRender: string; destination: string; nonce: string; status: "pending" | "granted" | "rejected" | "expired" | "invalidated" | "consumed";
      requestedAt: Date; expiresAt: Date; decidedBy: string | null; decidedAt: Date | null; consumedAt: Date | null;
    } | null : never = null;
    const store: Extract<IssueApprovalDependencies, { store: unknown }>['store'] = {
      insert: async (newApproval) => {
        row = {
          approvalId: randomUUID(), tenantId: newApproval.tenantId ?? "basileia", runId: newApproval.runId,
          capabilityId: newApproval.capabilityId, actionDigest: Buffer.from(newApproval.actionDigest),
          actionRender: newApproval.actionRender, destination: newApproval.destination, nonce: newApproval.nonce ?? randomUUID(),
          status: "pending", requestedAt: new Date(), expiresAt: newApproval.expiresAt,
          decidedBy: null, decidedAt: null, consumedAt: null,
        };
        return row;
      },
      getByNonce: async (nonce) => row?.nonce === nonce ? row : null,
      consume: async (nonce) => {
        if (row?.nonce !== nonce || row.status !== "granted") return { rowCount: 0, approval: null };
        row.status = "consumed";
        return { rowCount: 1, approval: row };
      },
      invalidate: async (nonce) => {
        if (row?.nonce === nonce && row.status === "granted") row.status = "invalidated";
        return { rowCount: 0, approval: null };
      },
      expirePending: async () => 0,
    };
    const issue = () => issueApproval({
      runId: request.runId, capabilityId: "email.send", toolName: request.toolName,
      input: request.input as never, destination: "review@example.test", tenantId: request.tenantId,
    }, { store });
    const issued = await issue();
    if (row === null) throw new Error("approval was not persisted");
    row.status = "granted";

    await expect(verifyAndConsume(issued.nonce, { store }, {
      toolName: request.toolName,
      input: request.input as never,
      destination: "review@example.test",
    })).resolves.toMatchObject({ consumed: true, rowCount: 1 });

    const mutatedIssued = await issue();
    if (row === null) throw new Error("approval was not persisted");
    row.status = "granted";

    await expect(verifyAndConsume(mutatedIssued.nonce, { store }, {
      toolName: request.toolName,
      input: { ...request.input, subject: "Mutated after approval" } as never,
      destination: "review@example.test",
    })).resolves.toEqual({ consumed: false, rowCount: 0 });
    expect(row.status).toBe("invalidated");
  });
});
