import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { SEALED_SECRET_ROOT } from "@oikonomos/shared";

import {
  builtinDescribers,
  BUILTIN_TOOLS,
  DESCRIBE_DENIED_AUDIT_TYPE,
  describeToolCall,
  handlePreToolUse,
  type BrokerDependencies,
  type PreToolUseRequest,
  type RegisteredCapability,
} from "./index.js";
import {
  SECRET_PATH_AUDIT_EVENT_TYPE,
  SECRET_PATH_DENIAL_REASON,
} from "./secretPathGuard.js";

const sealedTarget = `${SEALED_SECRET_ROOT}/browser-profile/Default/Cookies`;

const request: PreToolUseRequest = {
  toolUseId: "sealed-target-1",
  runId: "11111111-1111-1111-1111-111111111111",
  roleId: "office-manager",
  tenantId: "basileia",
  toolName: "mcp__office__read_file",
  input: { path: "workspace-alias" },
  agentRef: { provider: "claude", sessionRef: "session-1", isSubagent: false },
};

function autonomousCapability(): RegisteredCapability {
  return {
    toolName: request.toolName,
    capabilityId: "workspace.read",
    defaultTier: "T1_draft",
    enforcementEnabled: true,
    enforcedActionClasses: [],
  };
}

function dependencies(overrides: Partial<BrokerDependencies> = {}): BrokerDependencies {
  return {
    isCapabilitiesEnabled: vi.fn(() => true),
    getCapability: vi.fn(async () => autonomousCapability()),
    getRoleGrant: vi.fn(async () => ({ maxTier: "T4_irreversible" as const })),
    destinationFor: vi.fn(() => sealedTarget),
    issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
    consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
    issueApproval: vi.fn(),
    verifyAndConsume: vi.fn(),
    recordDecision: vi.fn(async () => ({ eventId: "audit-secret-1" })),
    ...overrides,
  };
}

describe("handlePreToolUse — D3 secret-path gate (Addendum F N13)", () => {
  it("denies a D3 target on the real path before an otherwise autonomous six-rank resolution", async () => {
    const deps = dependencies();

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: SECRET_PATH_DENIAL_REASON,
      auditEventId: "audit-secret-1",
    });
    expect(deps.getCapability).not.toHaveBeenCalled();
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "deny",
      reason: SECRET_PATH_DENIAL_REASON,
      payload: expect.objectContaining({
        type: SECRET_PATH_AUDIT_EVENT_TYPE,
        verdict: "deny",
        reason: SECRET_PATH_DENIAL_REASON,
      }),
    }));
  });

  it("preserves the guard's target-free distinct audit event through the real audit path", async () => {
    const deps = dependencies();

    await handlePreToolUse(request, deps);

    const event = vi.mocked(deps.recordDecision).mock.calls[0]?.[0];
    expect(event).toMatchObject({
      payload: {
        type: SECRET_PATH_AUDIT_EVENT_TYPE,
        verdict: "deny",
        reason: SECRET_PATH_DENIAL_REASON,
      },
    });
    expect(JSON.stringify(event)).not.toContain(sealedTarget);
  });

  it("keeps broker failure handling on the existing fail-closed path", async () => {
    const deps = dependencies({
      destinationFor: vi.fn(() => "/oikonomos/workspace/report.md"),
      getCapability: vi.fn(async () => {
        throw new Error("broker unavailable");
      }),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "broker.dependency_failure",
      auditEventId: "audit-secret-1",
    });
  });

  it("LIVENESS: removing the index guard call makes the sealed read canary RED", async () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

    expect(source).toMatch(/import\s*\{\s*guardSecretPath\s*\}\s*from\s*"\.\/secretPathGuard\.js"/);
    expect(source).toContain("guardSecretPath(destination)");

    const deps = dependencies();
    const response = await handlePreToolUse(request, deps);
    // Removing the call above lets this autonomous capability reach the executor.
    expect(response.decision).toBe("deny");
    expect(response.decision).not.toBe("allow");
  });
});

const UNDESCRIBABLE = "mcp__unknown__explode";

function approvalRequest(overrides: Partial<PreToolUseRequest> = {}): PreToolUseRequest {
  return {
    toolUseId: "describe-gate-1",
    runId: "11111111-1111-1111-1111-111111111111",
    roleId: "office-manager",
    tenantId: "basileia",
    toolName: UNDESCRIBABLE,
    input: { to: "review@example.test" },
    agentRef: { provider: "claude", sessionRef: "session-1", isSubagent: false },
    ...overrides,
  };
}

function t3Capability(toolName: string): RegisteredCapability {
  return {
    toolName,
    capabilityId: "email.send",
    defaultTier: "T3_external",
  };
}

function approvalDependencies(overrides: Partial<BrokerDependencies> = {}): BrokerDependencies {
  return {
    isCapabilitiesEnabled: vi.fn(() => true),
    getCapability: vi.fn(async (toolName: string) => t3Capability(toolName)),
    getRoleGrant: vi.fn(async () => ({ maxTier: "T4_irreversible" as const })),
    destinationFor: vi.fn(() => "review@example.test"),
    issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
    consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
    issueApproval: vi.fn(async () => ({
      reason: "approval_pending" as const,
      approvalId: "approval-should-not-issue",
      nonce: "nonce-should-not-issue",
      expiresAt: new Date("2026-09-06T00:01:00Z"),
      actionDigest: "a".repeat(64),
      actionRender: "should not issue",
      destination: "review@example.test",
      status: "pending" as const,
    })),
    verifyAndConsume: vi.fn(async () => ({ consumed: false as const, rowCount: 0 as const })),
    recordDecision: vi.fn(async () => ({ eventId: "audit-describe-1" })),
    ...overrides,
  };
}

describe("handlePreToolUse — describe-or-deny gate (TASK-194, study §Tier 1.2)", () => {
  it("denies an undescribable T3 tool on the real path before issuing any approval", async () => {
    const deps = approvalDependencies();
    const req = approvalRequest();

    await expect(handlePreToolUse(req, deps)).resolves.toEqual({
      decision: "deny",
      reason: "describe.undescribable",
      auditEventId: "audit-describe-1",
    });
    expect(deps.issueApproval).not.toHaveBeenCalled();
    expect(deps.verifyAndConsume).not.toHaveBeenCalled();
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "deny",
      reason: "describe.undescribable",
      payload: expect.objectContaining({
        type: DESCRIBE_DENIED_AUDIT_TYPE,
        code: "describe.undescribable",
      }),
    }));
  });

  it("does not let a nonce bypass the gate for an undescribable tool", async () => {
    const deps = approvalDependencies({
      verifyAndConsume: vi.fn(async () => ({
        consumed: true as const,
        rowCount: 1 as const,
        approval: {} as never,
      })),
    });

    await expect(handlePreToolUse(
      approvalRequest({ approvalNonce: randomUUID() }),
      deps,
    )).resolves.toEqual({
      decision: "deny",
      reason: "describe.undescribable",
      auditEventId: "audit-describe-1",
    });
    expect(deps.verifyAndConsume).not.toHaveBeenCalled();
    expect(deps.issueApproval).not.toHaveBeenCalled();
  });

  it("still issues approval for Bash (builtin describer)", async () => {
    const deps = approvalDependencies();
    const req = approvalRequest({
      toolName: "Bash",
      input: { command: "git status" },
    });

    await expect(handlePreToolUse(req, deps)).resolves.toMatchObject({
      decision: "deny",
      reason: "approval_pending",
      approvalId: "approval-should-not-issue",
    });
    expect(deps.issueApproval).toHaveBeenCalledOnce();
    expect(deps.issueApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Bash" }),
      deps.issueApprovalDependencies,
    );
  });

  it("still issues approval for Edit when the capability is approval-requiring", async () => {
    const deps = approvalDependencies({
      getCapability: vi.fn(async () => ({
        toolName: "Edit",
        capabilityId: "fs.write",
        defaultTier: "T3_external" as const,
      })),
    });
    const req = approvalRequest({
      toolName: "Edit",
      input: { file_path: "/workspace/note.md" },
    });

    await expect(handlePreToolUse(req, deps)).resolves.toMatchObject({
      decision: "deny",
      reason: "approval_pending",
    });
    expect(deps.issueApproval).toHaveBeenCalledOnce();
  });

  it("still issues approval for mcp__gmail__send_message via the default whitelist", async () => {
    const deps = approvalDependencies();
    const req = approvalRequest({ toolName: "mcp__gmail__send_message" });

    await expect(handlePreToolUse(req, deps)).resolves.toMatchObject({
      decision: "deny",
      reason: "approval_pending",
    });
    expect(deps.issueApproval).toHaveBeenCalledOnce();
    expect(Object.hasOwn(builtinDescribers, "mcp__gmail__send_message")).toBe(true);
  });

  it("denies an unpresentable target before issuing approval", async () => {
    const huge = "x".repeat(10_001);
    const deps = approvalDependencies({
      describers: {
        Bash: () => ({ action: "run command", target: huge }),
      },
    });
    const req = approvalRequest({ toolName: "Bash", input: { command: "echo" } });

    await expect(handlePreToolUse(req, deps)).resolves.toEqual({
      decision: "deny",
      reason: "describe.unpresentable",
      auditEventId: "audit-describe-1",
    });
    expect(deps.issueApproval).not.toHaveBeenCalled();
  });

  it("LIVENESS: removing the describeOrDeny call lets an undescribable T3 tool issue approval", async () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

    expect(source).toMatch(/import\s*\{[^}]*\bdescribeOrDeny\b[^}]*\}\s*from\s*"\.\/describe\.js"/);
    expect(source).toContain("describeOrDeny(");
    expect(source).toContain("DESCRIBE_DENIED_AUDIT_TYPE");

    const helper = source.slice(source.indexOf("async function resolveApprovalRequired"));
    const beforeIssue = helper.slice(0, helper.indexOf("dependencies.issueApproval("));
    expect(beforeIssue).toContain("describeOrDeny(");
    expect(beforeIssue).toContain('described.code');
    expect(beforeIssue).not.toContain("decision: \"approval_pending\"");

    const deps = approvalDependencies();
    const response = await handlePreToolUse(approvalRequest(), deps);
    // If resolveApprovalRequired stopped calling describeOrDeny, this T3
    // unknown tool would park as approval_pending and these assertions go red.
    expect(response).toEqual({
      decision: "deny",
      reason: "describe.undescribable",
      auditEventId: "audit-describe-1",
    });
    expect(response.decision).not.toBe("allow");
    expect(response).not.toMatchObject({ reason: "approval_pending" });
    expect(deps.issueApproval).not.toHaveBeenCalled();
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "deny",
      reason: "describe.undescribable",
      payload: expect.objectContaining({ type: DESCRIBE_DENIED_AUDIT_TYPE }),
    }));
  });

  it("registers a describer for every BUILTIN_TOOLS name, including Bash and Edit", () => {
    for (const tool of BUILTIN_TOOLS) {
      const described = describeToolCall(
        { toolName: tool.toolName, input: { label: "API token", purpose: "publish the release" } },
        builtinDescribers,
      );
      expect(described).toBeDefined();
      expect(described?.action.length).toBeGreaterThan(0);
    }
    expect(describeToolCall(
      { toolName: "Bash", input: { command: "git status" } },
      builtinDescribers,
    )).toEqual({ action: "run command", target: "git status" });
    expect(describeToolCall(
      { toolName: "Edit", input: { file_path: "/workspace/note.md" } },
      builtinDescribers,
    )).toEqual({ action: "edit file", target: "/workspace/note.md" });
  });
});
