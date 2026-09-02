import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { SEALED_SECRET_ROOT } from "@oikonomos/shared";

import {
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
