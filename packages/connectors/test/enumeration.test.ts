import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Public policy API (Handover §4.2). package.json is outside Owned_Paths so
// this is a source import of packages/policy/src/index.ts, not a new workspace dep.
import { resolveCapabilityTier } from "../../policy/src/index.js";
import {
  enumerateTools,
  serializeEnumerationReport,
  UNOBSERVABLE_ZERO_TOOLS,
  validateManifest,
  type ConnectorManifest,
  type EnumerationReport,
  type ToolEnumerator,
} from "../src/index.js";
import { handoverGmailYaml } from "./helpers.js";

const FIXED_NOW = () => new Date("2026-08-18T19:15:00.000Z");

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

const GMAIL_EXPOSED = [
  "mcp__gmail__list_messages",
  "mcp__gmail__create_draft",
  "mcp__gmail__send_message",
] as const;

describe("enumerateTools (OIK-049)", () => {
  it("maps every exposed tool to a capability with an explicit tier", async () => {
    const report = await enumerateTools(
      requireManifest(),
      enumeratorOf(GMAIL_EXPOSED),
      { now: FIXED_NOW },
    );

    expect(report.ok).toBe(true);
    expect(report.unmapped).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.mapped).toEqual([
      {
        toolName: "mcp__gmail__create_draft",
        capabilityId: "email.create_draft",
        defaultTier: "T1_draft",
      },
      {
        toolName: "mcp__gmail__list_messages",
        capabilityId: "email.list",
        defaultTier: "T0_observe",
      },
      {
        toolName: "mcp__gmail__send_message",
        capabilityId: "email.send",
        defaultTier: "T3_external",
      },
    ]);
    expect(report.mapped.every((tool) => tool.defaultTier.length > 0)).toBe(true);
    expect(report.generatedAt).toBe("2026-08-18T19:15:00.000Z");
    expect(report.connectorId).toBe("gmail");
  });

  it("fails and names every unmapped exposed tool", async () => {
    const report = await enumerateTools(
      requireManifest(),
      enumeratorOf([
        ...GMAIL_EXPOSED,
        "mcp__gmail__delete_message",
        "mcp__gmail__forward",
      ]),
      { now: FIXED_NOW },
    );

    expect(report.ok).toBe(false);
    expect(report.unmapped).toEqual([
      "mcp__gmail__delete_message",
      "mcp__gmail__forward",
    ]);
    expect(report.message).toBe(
      "unmapped tools: mcp__gmail__delete_message, mcp__gmail__forward",
    );
  });

  it("MUTATION-PROVEN: treating unmapped tools as pass turns this test red", async () => {
    const report = await enumerateTools(
      requireManifest(),
      enumeratorOf(["mcp__gmail__list_messages", "mcp__gmail__archive"]),
    );

    // If enumerateTools set ok:true whenever any tool mapped, this fails.
    expect(report.ok).toBe(false);
    expect(report.unmapped).toContain("mcp__gmail__archive");
    expect(report.mapped.map((tool) => tool.toolName)).toEqual([
      "mcp__gmail__list_messages",
    ]);
  });

  it("flags stale manifest tools as warnings without failing the check", async () => {
    const report = await enumerateTools(
      requireManifest(),
      enumeratorOf(["mcp__gmail__list_messages", "mcp__gmail__create_draft"]),
    );

    expect(report.ok).toBe(true);
    expect(report.unmapped).toEqual([]);
    expect(report.stale).toEqual([
      {
        toolName: "mcp__gmail__send_message",
        capabilityId: "email.send",
        defaultTier: "T3_external",
      },
    ]);
    expect(report.warnings).toEqual([
      "stale mapping: mcp__gmail__send_message (email.send) is no longer exposed",
    ]);
    expect(report.message).toMatch(/stale warning/);
  });

  it("fails as unobservable when listTools returns zero tools (ADR-005)", async () => {
    const report = await enumerateTools(requireManifest(), enumeratorOf([]));

    expect(report.ok).toBe(false);
    expect(report.unobservable).toBe("zero_tools");
    expect(report.message.startsWith(UNOBSERVABLE_ZERO_TOOLS)).toBe(true);
    expect(report.mapped).toEqual([]);
    expect(report.unmapped).toEqual([]);
  });

  it("fails closed when listTools throws", async () => {
    const report = await enumerateTools(requireManifest(), {
      async listTools() {
        throw new Error("mcp unreachable");
      },
    });

    expect(report.ok).toBe(false);
    expect(report.unobservable).toBeUndefined();
    expect(report.message).toBe("listTools failed: mcp unreachable");
  });

  it("serializes a persistable JSON artifact that round-trips", async () => {
    const report = await enumerateTools(
      requireManifest(),
      enumeratorOf(["mcp__gmail__list_messages", "mcp__unknown__tool"]),
      { now: FIXED_NOW },
    );
    const json = serializeEnumerationReport(report);
    const parsed = JSON.parse(json) as EnumerationReport;

    expect(json.endsWith("\n")).toBe(true);
    expect(parsed).toEqual(report);

    const dir = await mkdtemp(join(tmpdir(), "oik-enum-"));
    try {
      const path = join(dir, "gmail.enumeration.json");
      await writeFile(path, json, "utf8");
      const fromDisk = JSON.parse(await readFile(path, "utf8")) as EnumerationReport;
      expect(fromDisk.unmapped).toEqual(["mcp__unknown__tool"]);
      expect(fromDisk.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Handover §4.2 unmapped tool ⇒ policy deny", () => {
  it("drives resolveCapabilityTier with an unmapped name and asserts deny", async () => {
    const unmappedName = "mcp__gmail__unmapped_probe";
    const report = await enumerateTools(
      requireManifest(),
      enumeratorOf([...GMAIL_EXPOSED, unmappedName]),
    );

    expect(report.ok).toBe(false);
    expect(report.unmapped).toEqual([unmappedName]);

    // Only mapped tools would be registered. Policy is consumed read-only.
    const registered = report.mapped.map((tool) => ({
      toolName: tool.toolName,
      defaultTier: tool.defaultTier,
    }));

    const denied = resolveCapabilityTier({
      toolName: unmappedName,
      capabilities: registered,
    });
    expect(denied).toEqual({
      decision: "deny",
      reason: "capability.unregistered",
    });

    const allowed = resolveCapabilityTier({
      toolName: "mcp__gmail__list_messages",
      capabilities: registered,
    });
    expect(allowed).toEqual({ decision: "allow", tier: "T0_observe" });
  });
});
