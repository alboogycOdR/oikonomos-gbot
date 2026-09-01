import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  handlePreToolUse,
  type BrokerDependencies,
  type PreToolUseRequest,
  type RegisteredCapability,
} from "./index.js";
import {
  ALLOWLIST_MISS_REASON,
  recheckAgainstManifest,
} from "./recheck.js";

const LIST = "mcp__gmail__list_messages";
const SEND = "mcp__gmail__send_message";

const request: PreToolUseRequest = {
  toolUseId: "tool-use-stale-1",
  runId: "11111111-1111-1111-1111-111111111111",
  roleId: "inbox-triage",
  tenantId: "basileia",
  toolName: LIST,
  input: { to: "review@example.test" },
  agentRef: { provider: "codex", sessionRef: "session-1", isSubagent: false },
};

function capability(overrides: Partial<RegisteredCapability> = {}): RegisteredCapability {
  return {
    toolName: LIST,
    capabilityId: "email.list",
    defaultTier: "T1_draft",
    ...overrides,
  };
}

function dependencies(overrides: Partial<BrokerDependencies> = {}): BrokerDependencies {
  return {
    isCapabilitiesEnabled: vi.fn(() => true),
    getCapability: vi.fn(async () => capability()),
    getRoleGrant: vi.fn(async () => ({ maxTier: "T3_external" as const })),
    destinationFor: vi.fn(() => "review@example.test"),
    issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
    consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
    issueApproval: vi.fn(async () => ({
      reason: "approval_pending" as const,
      approvalId: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      actionDigest: "a".repeat(64),
      actionRender: "derived downstream",
      destination: "review@example.test",
      status: "pending" as const,
    })),
    verifyAndConsume: vi.fn(async () => ({ consumed: false as const, rowCount: 0 as const })),
    recordDecision: vi.fn(async () => ({ eventId: "42" })),
    ...overrides,
  };
}

describe("recheckAgainstManifest — call-time allowlist re-check (study §Tier 1.6)", () => {
  it("allows a tool present on the manifest map", () => {
    expect(recheckAgainstManifest(LIST, new Set([LIST]))).toEqual({ decision: "allow" });
    expect(recheckAgainstManifest(LIST, [LIST])).toEqual({ decision: "allow" });
    expect(recheckAgainstManifest(LIST, { [LIST]: true })).toEqual({ decision: "allow" });
    expect(recheckAgainstManifest(LIST, new Map([[LIST, true]]))).toEqual({ decision: "allow" });
  });

  it("denies a tool absent from the manifest map even when it appears in the mounted tool list", () => {
    const mountedToolList = [LIST, SEND];
    const manifestMap = new Set([LIST]);

    expect(mountedToolList).toContain(SEND);
    expect(recheckAgainstManifest(SEND, manifestMap)).toEqual({
      decision: "deny",
      reason: ALLOWLIST_MISS_REASON,
    });
    expect(recheckAgainstManifest(LIST, manifestMap)).toEqual({ decision: "allow" });
  });

  it("denies an empty or non-string tool name", () => {
    expect(recheckAgainstManifest("", new Set([LIST]))).toEqual({
      decision: "deny",
      reason: ALLOWLIST_MISS_REASON,
    });
  });

  it("uses Object.hasOwn so prototype-inherited names are not allowlisted", () => {
    const poisoned = Object.create({ [SEND]: true }) as Record<string, unknown>;
    poisoned[LIST] = true;
    expect(recheckAgainstManifest(LIST, poisoned)).toEqual({ decision: "allow" });
    expect(recheckAgainstManifest(SEND, poisoned)).toEqual({
      decision: "deny",
      reason: ALLOWLIST_MISS_REASON,
    });
  });
});

describe("handlePreToolUse — additive call-time re-check (ADR-001 L1 unchanged)", () => {
  it("denies a stale-list tool that L1 would otherwise allow", async () => {
    const mountedToolList = [LIST, SEND];
    const deps = dependencies({
      manifestMap: new Set([LIST]),
      getCapability: vi.fn(async (toolName: string) => capability({
        toolName,
        capabilityId: toolName === SEND ? "email.send" : "email.list",
        defaultTier: "T1_draft",
      })),
    });

    expect(mountedToolList).toContain(SEND);

    await expect(handlePreToolUse({ ...request, toolName: SEND }, deps)).resolves.toEqual({
      decision: "deny",
      reason: ALLOWLIST_MISS_REASON,
      auditEventId: "42",
    });
    expect(deps.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "deny",
      reason: ALLOWLIST_MISS_REASON,
    }));
    // Recheck must run before capability lookup — a miss is not "unregistered".
    expect(deps.getCapability).not.toHaveBeenCalled();
  });

  it("falls through to L1 when the tool is on the manifest map", async () => {
    const deps = dependencies({
      manifestMap: new Set([LIST]),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "allow",
      tier: "T1_draft",
      auditEventId: "42",
    });
    expect(deps.getCapability).toHaveBeenCalledOnce();
  });

  it("does not skip L1 after a recheck hit: unregistered still denies", async () => {
    const deps = dependencies({
      manifestMap: new Set([LIST]),
      getCapability: vi.fn(async () => null),
    });

    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "deny",
      reason: "capability.unregistered",
      auditEventId: "42",
    });
  });

  it("leaves the existing L1 path unchanged when no manifestMap is supplied", async () => {
    const deps = dependencies();
    await expect(handlePreToolUse(request, deps)).resolves.toEqual({
      decision: "allow",
      tier: "T1_draft",
      auditEventId: "42",
    });
  });

  it("MUTATION-PROVEN: skipping the call-time re-check turns a stale-tool-list test RED", async () => {
    const indexSource = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    const recheckSource = readFileSync(fileURLToPath(new URL("./recheck.ts", import.meta.url)), "utf8");

    expect(indexSource).toMatch(/import\s*\{[^}]*\brecheckAgainstManifest\b[^}]*\}\s*from\s*"\.\/recheck\.js"/);
    expect(indexSource).toContain("recheckAgainstManifest(request.toolName, dependencies.manifestMap)");
    expect(indexSource).toContain("ALLOWLIST_MISS_REASON");
    expect(recheckSource).toContain("if (!manifestHas(manifestMap, toolName))");

    const mountedToolList = [LIST, SEND];
    const deps = dependencies({
      manifestMap: new Set([LIST]),
      getCapability: vi.fn(async (toolName: string) => capability({
        toolName,
        defaultTier: "T1_draft",
      })),
    });

    expect(mountedToolList).toContain(SEND);

    const decision = await handlePreToolUse({ ...request, toolName: SEND }, deps);
    // If decidePreToolUse stopped calling recheckAgainstManifest, L1 would
    // ALLOW this T1-registered stale tool and this assertion would go red.
    expect(decision).toEqual({
      decision: "deny",
      reason: ALLOWLIST_MISS_REASON,
      auditEventId: "42",
    });
    expect(decision.decision).not.toBe("allow");
  });
});
