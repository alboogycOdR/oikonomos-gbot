import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCapabilityTier } from "@oikonomos/policy";
import {
  enumerateTools,
  serializeEnumerationReport,
  UNOBSERVABLE_ZERO_TOOLS,
  validateManifest,
  type ConnectorManifest,
  type EnumerationReport,
  type ToolEnumerator,
} from "../src/index.js";
import {
  allowedToolsFor,
  createHttpMcpToolEnumerator,
} from "../src/enumeration/index.js";
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

/** Live Gmail MCP names reported by ORCH 2026-09-01 — used as a local mount fixture. */
const LIVE_GMAIL_BARE_TOOLS = [
  "send_message",
  "reply",
  "forward",
  "create_draft",
  "search_threads",
  "get_message",
  "get_thread",
  "list_drafts",
  "list_labels",
] as const;

type MountHandler = (body: Record<string, unknown>, res: ServerResponse) => void;

async function withMountedMcp(
  handler: MountHandler,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        res.statusCode = 400;
        res.end();
        return;
      }
      handler(body, res);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  try {
    await run(url);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

function jsonRpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }));
}

function defaultMcpHandler(toolNames: readonly string[]): MountHandler {
  return (body, res) => {
    const method = body.method;
    const id = body.id;
    if (method === "initialize") {
      jsonRpcResult(res, id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "gmail", version: "test" },
      });
      return;
    }
    if (method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (method === "tools/list") {
      jsonRpcResult(
        res,
        id,
        { tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" } })) },
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  };
}

describe("createHttpMcpToolEnumerator — mounted MCP server (OIK-049)", () => {
  it("enumerates tools from a real HTTP MCP mount and qualifies bare names", async () => {
    await withMountedMcp(defaultMcpHandler(["list_messages", "create_draft", "send_message"]), async (url) => {
      const enumerator = createHttpMcpToolEnumerator("gmail", { transport: "http", url });
      const report = await enumerateTools(requireManifest(), enumerator, { now: FIXED_NOW });

      expect(report.ok).toBe(true);
      expect(report.mapped.map((tool) => tool.toolName)).toEqual([
        "mcp__gmail__create_draft",
        "mcp__gmail__list_messages",
        "mcp__gmail__send_message",
      ]);
      expect(report.unmapped).toEqual([]);
      expect(report.generatedAt).toBe("2026-08-18T19:15:00.000Z");
    });
  });

  it("does not read process.env for the MCP url (N4)", async () => {
    const previous = process.env.OIK_SECRET_MCP_GMAIL_URL;
    process.env.OIK_SECRET_MCP_GMAIL_URL = "https://must-not-be-read.invalid/gmail";
    try {
      await withMountedMcp(defaultMcpHandler(["list_messages"]), async (url) => {
        const enumerator = createHttpMcpToolEnumerator("gmail", { transport: "http", url });
        const report = await enumerateTools(requireManifest(), enumerator);
        expect(report.mapped.map((tool) => tool.toolName)).toContain("mcp__gmail__list_messages");
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OIK_SECRET_MCP_GMAIL_URL;
      } else {
        process.env.OIK_SECRET_MCP_GMAIL_URL = previous;
      }
    }
  });

  it("never interpolates the url into enumerator errors (N4)", async () => {
    const sentinel = ["https://", "enum-secret-", "host.invalid/", "gmail"].join("");
    const enumerator = createHttpMcpToolEnumerator(
      "gmail",
      { transport: "http", url: sentinel },
      {
        fetch: async () => {
          throw new Error(`getaddrinfo ENOTFOUND enum-secret-host.invalid for ${sentinel}`);
        },
      },
    );
    const report = await enumerateTools(requireManifest(), enumerator);
    expect(report.ok).toBe(false);
    expect(report.message).toBe("listTools failed: transport error");
    expect(report.message).not.toContain(sentinel);
    expect(report.message).not.toContain("enum-secret-host");
  });

  it("fails closed on HTTP 500 from the mounted server", async () => {
    await withMountedMcp((_body, res) => {
      res.statusCode = 500;
      res.end("nope");
    }, async (url) => {
      const enumerator = createHttpMcpToolEnumerator("gmail", { transport: "http", url });
      const report = await enumerateTools(requireManifest(), enumerator);
      expect(report.ok).toBe(false);
      expect(report.message).toBe("listTools failed: HTTP 500");
      expect(report.message).not.toContain(url);
    });
  });

  it("parses a streamable-HTTP SSE tools/list response", async () => {
    await withMountedMcp((body, res) => {
      const method = body.method;
      const id = body.id;
      if (method === "initialize") {
        jsonRpcResult(res, id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "gmail", version: "test" },
        });
        return;
      }
      if (method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (method === "tools/list") {
        res.setHeader("content-type", "text/event-stream");
        res.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { tools: [{ name: "list_messages", inputSchema: { type: "object" } }] },
          })}\n\n`,
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    }, async (url) => {
      const enumerator = createHttpMcpToolEnumerator("gmail", { transport: "http", url });
      const report = await enumerateTools(requireManifest(), enumerator);
      expect(report.mapped.map((tool) => tool.toolName)).toEqual(["mcp__gmail__list_messages"]);
    });
  });

  const liveUrl = process.env.OIK_SECRET_MCP_GMAIL_URL;

  it.skipIf(!liveUrl)("enumerates the provisioned Gmail MCP server (not faked)", async () => {
    const enumerator = createHttpMcpToolEnumerator("gmail", {
      transport: "http",
      url: liveUrl ?? "",
    });
    const report = await enumerateTools(requireManifest(), enumerator);
    const allowlist = allowedToolsFor(requireManifest(), report);

    expect(report.mapped.map((tool) => tool.toolName)).toContain("mcp__gmail__create_draft");
    expect(allowlist).toEqual(["mcp__gmail__create_draft"]);
    expect(allowlist).not.toContain("mcp__gmail__send_message");
    expect(allowlist).not.toContain("mcp__gmail__reply");
    expect(allowlist).not.toContain("mcp__gmail__forward");
    expect(report.unmapped).toContain("mcp__gmail__search_threads");
    expect(report.unmapped).toContain("mcp__gmail__trash_message");
    expect(report.stale.map((tool) => tool.toolName)).toContain("mcp__gmail__send_message");
    expect(report.ok).toBe(false);
    expect(report.message).not.toMatch(/https?:\/\//);
  });

  it("maps the live Gmail surface: send_message mapped+disabled; reply/forward unmapped", async () => {
    await withMountedMcp(defaultMcpHandler(LIVE_GMAIL_BARE_TOOLS), async (url) => {
      const enumerator = createHttpMcpToolEnumerator("gmail", { transport: "http", url });
      const report = await enumerateTools(requireManifest(), enumerator);
      const allowlist = allowedToolsFor(requireManifest(), report);

      expect(report.mapped.map((tool) => tool.toolName)).toEqual([
        "mcp__gmail__create_draft",
        "mcp__gmail__send_message",
      ]);
      expect(report.unmapped).toEqual([
        "mcp__gmail__forward",
        "mcp__gmail__get_message",
        "mcp__gmail__get_thread",
        "mcp__gmail__list_drafts",
        "mcp__gmail__list_labels",
        "mcp__gmail__reply",
        "mcp__gmail__search_threads",
      ]);
      expect(allowlist).toEqual(["mcp__gmail__create_draft"]);
      expect(allowlist).not.toContain("mcp__gmail__send_message");
      expect(allowlist).not.toContain("mcp__gmail__reply");
      expect(allowlist).not.toContain("mcp__gmail__forward");
    });
  });
});

