import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  handlePreToolUse,
  type BrokerDependencies,
  type PreToolUseRequest,
  type RegisteredCapability,
} from "../../broker/src/index.js";
import {
  allowedToolsFor,
  AllowedToolsError,
  createHttpMcpToolEnumerator,
  enumerateTools,
  isFullyQualifiedMcpName,
  type EnumerationReport,
  type ToolEnumerator,
} from "../src/enumeration/index.js";
import { validateManifest, type ConnectorManifest } from "../src/index.js";
import { handoverGmailYaml } from "./helpers.js";

const GMAIL_EXPOSED = [
  "mcp__gmail__list_messages",
  "mcp__gmail__create_draft",
  "mcp__gmail__send_message",
] as const;

const LIVE_SEND_CAPABLE = [
  "mcp__gmail__send_message",
  "mcp__gmail__reply",
  "mcp__gmail__forward",
] as const;

function requireManifest(): ConnectorManifest {
  const result = validateManifest(handoverGmailYaml());
  if (!result.ok) {
    throw new Error("gmail handover fixture must validate");
  }
  return result.manifest;
}

function enumeratorOf(names: readonly string[]): ToolEnumerator {
  return {
    async listTools() {
      return names;
    },
  };
}

async function reportFor(names: readonly string[]): Promise<EnumerationReport> {
  return enumerateTools(requireManifest(), enumeratorOf(names));
}

function manifestWithToolName(toolName: string): ConnectorManifest {
  const base = requireManifest();
  const tools = base.tools.map((tool, index) =>
    index === 0 ? { ...tool, tool_name: toolName } : tool,
  );
  return { ...base, tools };
}

describe("allowedToolsFor — L2 derivation (ADR-001 L2)", () => {
  it("emits only fully-qualified mcp__<server>__<tool> names", async () => {
    const report = await reportFor(GMAIL_EXPOSED);
    const allowlist = allowedToolsFor(requireManifest(), report);

    expect(allowlist.length).toBeGreaterThan(0);
    for (const name of allowlist) {
      expect(isFullyQualifiedMcpName(name)).toBe(true);
      expect(name.startsWith("mcp__")).toBe(true);
      expect(name).not.toContain("*");
      expect(name).not.toContain("?");
      expect(name).not.toContain("(");
    }
  });

  it("omits unmapped tools from the allowlist", async () => {
    const report = await reportFor([
      ...GMAIL_EXPOSED,
      "mcp__gmail__reply",
      "mcp__gmail__forward",
      "mcp__gmail__delete_message",
    ]);
    const allowlist = allowedToolsFor(requireManifest(), report);

    expect(report.unmapped).toEqual([
      "mcp__gmail__delete_message",
      "mcp__gmail__forward",
      "mcp__gmail__reply",
    ]);
    expect(allowlist).not.toContain("mcp__gmail__reply");
    expect(allowlist).not.toContain("mcp__gmail__forward");
    expect(allowlist).not.toContain("mcp__gmail__delete_message");
    expect(allowlist).toContain("mcp__gmail__list_messages");
    expect(allowlist).toContain("mcp__gmail__create_draft");
  });

  it("omits enabled: false capabilities (email.send / mcp__gmail__send_message) by name (WBS §4 G-CONN)", async () => {
    const report = await reportFor(GMAIL_EXPOSED);
    const allowlist = allowedToolsFor(requireManifest(), report);

    expect(report.mapped.map((tool) => tool.toolName)).toContain("mcp__gmail__send_message");
    expect(allowlist).not.toContain("mcp__gmail__send_message");
    expect(allowlist).not.toContain("email.send");
    expect(allowlist).toEqual([
      "mcp__gmail__create_draft",
      "mcp__gmail__list_messages",
    ]);
  });

  it("MUTATION-PROVEN: allowing enabled: false capabilities into the allowlist turns this test red", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/enumeration/allowedTools.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("if (entry.enabled === false)");
    expect(source).toContain("continue");

    const report = await reportFor(GMAIL_EXPOSED);
    const allowlist = allowedToolsFor(requireManifest(), report);
    // If allowedToolsFor stopped filtering enabled:false, send_message leaks here.
    expect(allowlist).not.toContain("mcp__gmail__send_message");
    expect(allowlist.some((name) => name.includes("send"))).toBe(false);
  });

  it("rejects a mapped bare name by construction (ADR-001 L2 / CAN-02)", async () => {
    const manifest = manifestWithToolName("list_messages");
    const report = await enumerateTools(manifest, enumeratorOf(["list_messages"]));
    expect(report.mapped.map((tool) => tool.toolName)).toEqual(["list_messages"]);
    expect(() => allowedToolsFor(manifest, report)).toThrow(AllowedToolsError);
    try {
      allowedToolsFor(manifest, report);
      expect.unreachable("bare name must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AllowedToolsError);
      const named = error as AllowedToolsError;
      expect(named.code).toBe("BARE_NAME");
      expect(named.entry).toBe("list_messages");
    }
  });

  it("rejects wildcards by construction", async () => {
    const manifest = manifestWithToolName("mcp__gmail__*");
    const report = await enumerateTools(manifest, enumeratorOf(["mcp__gmail__*"]));
    expect(() => allowedToolsFor(manifest, report)).toThrow(AllowedToolsError);
    try {
      allowedToolsFor(manifest, report);
      expect.unreachable("wildcard must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AllowedToolsError);
      expect((error as AllowedToolsError).code).toBe("WILDCARD");
    }
  });

  it("rejects scoped Tool(spec) form by construction", async () => {
    const manifest = manifestWithToolName("mcp__gmail__list_messages(*)");
    const report = await enumerateTools(
      manifest,
      enumeratorOf(["mcp__gmail__list_messages(*)"]),
    );
    expect(() => allowedToolsFor(manifest, report)).toThrow(AllowedToolsError);
  });
});

describe("allowlist is defence in depth — L1 still decides (ADR-001; Handover §4.2)", () => {
  function l1Request(toolName: string): PreToolUseRequest {
    return {
      toolUseId: randomUUID(),
      runId: "11111111-1111-1111-1111-111111111111",
      roleId: "inbox-triage",
      tenantId: "basileia",
      toolName,
      input: { to: "review@example.test" },
      agentRef: { provider: "codex", sessionRef: "session-1", isSubagent: false },
    };
  }

  function brokerDeps(catalog: readonly RegisteredCapability[]): BrokerDependencies {
    const byName = new Map(catalog.map((cap) => [cap.toolName, cap]));
    return {
      isCapabilitiesEnabled: () => true,
      getCapability: async (toolName) => byName.get(toolName) ?? null,
      getRoleGrant: async () => ({ maxTier: "T1_draft" }),
      destinationFor: () => "review@example.test",
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
      verifyAndConsume: vi.fn(async () => ({ consumed: false, rowCount: 0 })),
      recordDecision: vi.fn(async () => ({ eventId: "42" })),
    };
  }

  it("omits unmapped send-capable tools AND L1 denies them independently of the allowlist", async () => {
    const report = await reportFor([
      ...GMAIL_EXPOSED,
      "mcp__gmail__reply",
      "mcp__gmail__forward",
    ]);
    const allowlist = allowedToolsFor(requireManifest(), report);

    for (const name of LIVE_SEND_CAPABLE) {
      expect(allowlist).not.toContain(name);
    }

    // L1 catalog is the enabled mapped set — the allowlist is NOT consulted.
    const catalog: RegisteredCapability[] = report.mapped
      .filter((tool) => allowlist.includes(tool.toolName))
      .map((tool) => ({
        toolName: tool.toolName,
        capabilityId: tool.capabilityId,
        defaultTier: tool.defaultTier,
      }));
    const deps = brokerDeps(catalog);

    for (const name of ["mcp__gmail__reply", "mcp__gmail__forward"] as const) {
      const decision = await handlePreToolUse(l1Request(name), deps);
      expect(decision).toEqual({
        decision: "deny",
        reason: "capability.unregistered",
        auditEventId: "42",
      });
    }

    const listDecision = await handlePreToolUse(l1Request("mcp__gmail__list_messages"), deps);
    expect(listDecision).toEqual({
      decision: "allow",
      tier: "T0_observe",
      auditEventId: "42",
    });
  });

  it("CAN-02 layering: injecting send_message onto a local allowlist copy does not change L1", async () => {
    const report = await reportFor(GMAIL_EXPOSED);
    const allowlist = allowedToolsFor(requireManifest(), report);
    expect(allowlist).not.toContain("mcp__gmail__send_message");

    const poisoned = Object.freeze([...allowlist, "mcp__gmail__send_message"]);
    expect(poisoned).toContain("mcp__gmail__send_message");

    // L1 does not read allowedTools. send_message is registered (manifest row)
    // at T3; without an approval nonce L1 still denies (approval_pending).
    const send = report.mapped.find((tool) => tool.toolName === "mcp__gmail__send_message");
    expect(send).toBeDefined();
    const catalog: RegisteredCapability[] = [
      ...report.mapped
        .filter((tool) => allowlist.includes(tool.toolName))
        .map((tool) => ({
          toolName: tool.toolName,
          capabilityId: tool.capabilityId,
          defaultTier: tool.defaultTier,
        })),
      {
        toolName: "mcp__gmail__send_message",
        capabilityId: send!.capabilityId,
        defaultTier: send!.defaultTier,
      },
    ];
    const deps = brokerDeps(catalog);
    const decision = await handlePreToolUse(l1Request("mcp__gmail__send_message"), deps);

    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("role.tier_ceiling");
    expect(poisoned).toContain("mcp__gmail__send_message");
  });

  const liveUrl = process.env.OIK_SECRET_MCP_GMAIL_URL;

  it.skipIf(!liveUrl)("L1 denies a live unmapped Gmail tool independently of the allowlist", async () => {
    const enumerator = createHttpMcpToolEnumerator("gmail", {
      transport: "http",
      url: liveUrl ?? "",
    });
    const report = await enumerateTools(requireManifest(), enumerator);
    const allowlist = allowedToolsFor(requireManifest(), report);
    expect(allowlist).not.toContain("mcp__gmail__trash_message");
    expect(report.unmapped).toContain("mcp__gmail__trash_message");

    const catalog: RegisteredCapability[] = report.mapped
      .filter((tool) => allowlist.includes(tool.toolName))
      .map((tool) => ({
        toolName: tool.toolName,
        capabilityId: tool.capabilityId,
        defaultTier: tool.defaultTier,
      }));
    const deps = brokerDeps(catalog);
    const decision = await handlePreToolUse(l1Request("mcp__gmail__trash_message"), deps);
    expect(decision).toEqual({
      decision: "deny",
      reason: "capability.unregistered",
      auditEventId: "42",
    });
  });

  it("L1 denies send_message as unregistered when the disabled capability is not in the catalog", async () => {
    const report = await reportFor(GMAIL_EXPOSED);
    const allowlist = allowedToolsFor(requireManifest(), report);
    const catalog: RegisteredCapability[] = report.mapped
      .filter((tool) => allowlist.includes(tool.toolName))
      .map((tool) => ({
        toolName: tool.toolName,
        capabilityId: tool.capabilityId,
        defaultTier: tool.defaultTier,
      }));
    const deps = brokerDeps(catalog);
    const decision = await handlePreToolUse(l1Request("mcp__gmail__send_message"), deps);
    expect(decision).toEqual({
      decision: "deny",
      reason: "capability.unregistered",
      auditEventId: "42",
    });
  });
});
