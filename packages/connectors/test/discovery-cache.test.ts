import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  enumerateTools,
  validateManifest,
  type ConnectorManifest,
} from "../src/index.js";
import {
  allowedToolsFor,
  createHttpMcpToolEnumerator,
} from "../src/enumeration/index.js";
import {
  createDiscoveryCache,
  DiscoveryError,
  DISCOVERY_CACHE_LAYER,
  enumeratorsFrom,
  serverSetKey,
  type DiscoveryCache,
} from "../src/discovery-cache/index.js";
import { handoverGmailYaml } from "./helpers.js";

const GMAIL_TOOLS = ["mcp__gmail__list_messages", "mcp__gmail__create_draft"] as const;
const CALENDAR_TOOLS = ["mcp__calendar__list_events"] as const;
const TTL_MS = 60_000;

function requireManifest(): ConnectorManifest {
  const result = validateManifest(handoverGmailYaml());
  if (!result.ok) {
    throw new Error("gmail handover fixture must validate");
  }
  return result.manifest;
}

function discoveryCacheSource(): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/discovery-cache");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

interface Harness {
  cache: DiscoveryCache;
  names: string[] | undefined;
  calls: string[];
  tasks: Array<() => void>;
  nowMs: number;
  setList: (server: string, impl: () => Promise<readonly string[]>) => void;
  advance: (ms: number) => void;
  flush: () => void;
}

function makeCacheFixture(initialNames: string[] | undefined = ["gmail"]): Harness {
  const lists = new Map<string, () => Promise<readonly string[]>>();
  const state: Harness = {
    cache: undefined as unknown as DiscoveryCache,
    names: initialNames === undefined ? undefined : [...initialNames],
    calls: [],
    tasks: [],
    nowMs: 1_000_000,
    setList: (server, impl) => {
      lists.set(server, impl);
    },
    advance: (ms) => {
      state.nowMs += ms;
    },
    flush: () => {
      const queued = state.tasks.splice(0);
      for (const task of queued) {
        task();
      }
    },
  };

  lists.set("gmail", async () => [...GMAIL_TOOLS]);
  lists.set("calendar", async () => [...CALENDAR_TOOLS]);
  lists.set("drive", async () => ["mcp__drive__list_files"]);

  state.cache = createDiscoveryCache({
    peekServerNames: () => (state.names === undefined ? undefined : [...state.names]),
    listTools: async (serverName) => {
      state.calls.push(serverName);
      const impl = lists.get(serverName);
      if (impl === undefined) {
        throw new Error("listTools failed: unknown server");
      }
      return impl();
    },
    now: () => state.nowMs,
    ttlMs: TTL_MS,
    schedule: (task) => {
      state.tasks.push(task);
    },
  });

  return state;
}

async function drain(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // in-flight refresh may reject; SWR swallows into stale
  }
  await Promise.resolve();
  await Promise.resolve();
}

describe("serverSetKey", () => {
  it("is the sorted unique server-name set; order does not matter", () => {
    expect(serverSetKey(["gmail", "calendar"])).toBe(serverSetKey(["calendar", "gmail"]));
    expect(serverSetKey(["gmail", "gmail", "calendar"])).toBe(serverSetKey(["calendar", "gmail"]));
    expect(serverSetKey(["gmail"])).not.toBe(serverSetKey(["gmail", "calendar"]));
    expect(serverSetKey(["gmail"])).not.toBe(serverSetKey(["drive"]));
    expect(serverSetKey([])).toBe("");
  });

  it("rejects an empty server name", () => {
    expect(() => serverSetKey(["gmail", ""])).toThrow(/empty name/);
  });
});

describe("createDiscoveryCache — server-set key", () => {
  it("treats a changed mounted set as a distinct key", async () => {
    const h = makeCacheFixture(["gmail", "calendar"]);
    const first = await h.cache.getTools();
    expect(first.requestedKey).toBe(serverSetKey(["calendar", "gmail"]));
    expect(first.resolvedKey).toBe(first.requestedKey);
    expect(first.tools).toEqual([...CALENDAR_TOOLS, ...GMAIL_TOOLS]);
    expect(h.calls.sort()).toEqual(["calendar", "gmail"]);

    h.calls.length = 0;
    h.names = ["calendar", "gmail"];
    const sameSet = await h.cache.getTools();
    expect(sameSet.requestedKey).toBe(first.requestedKey);
    expect(sameSet.tools).toEqual(first.tools);
    expect(h.calls).toEqual([]);

    h.names = ["gmail"];
    const changed = await h.cache.getTools();
    expect(changed.requestedKey).toBe(serverSetKey(["gmail"]));
    expect(changed.requestedKey).not.toBe(first.requestedKey);
    expect(changed.tools).toEqual([...GMAIL_TOOLS]);
    expect(h.calls).toEqual(["gmail"]);
  });

  it("records requested vs resolved key so a mid-flight config change is not misattributed", async () => {
    let peeks = 0;
    const cache = createDiscoveryCache({
      peekServerNames: () => {
        peeks += 1;
        return peeks === 1 ? ["gmail"] : ["gmail", "calendar"];
      },
      listTools: async (name) => (name === "calendar" ? [...CALENDAR_TOOLS] : [...GMAIL_TOOLS]),
      now: () => 1,
      ttlMs: TTL_MS,
      schedule: () => undefined,
    });

    const snap = await cache.getTools();
    expect(snap.requestedKey).toBe(serverSetKey(["gmail"]));
    expect(snap.resolvedKey).toBe(serverSetKey(["gmail", "calendar"]));
    expect(snap.requestedKey).not.toBe(snap.resolvedKey);
    expect(snap.tools).toEqual([...CALENDAR_TOOLS, ...GMAIL_TOOLS]);
  });
});

describe("createDiscoveryCache — stale-while-revalidate", () => {
  it("on TTL expiry serves stale tools and kicks a refresh (injected clock)", async () => {
    const h = makeCacheFixture(["gmail"]);
    const fresh = await h.cache.getTools();
    expect(fresh.servedStale).toBe(false);
    expect(fresh.tools).toEqual([...GMAIL_TOOLS]);
    const callsAfterFill = h.calls.length;

    h.advance(TTL_MS + 1);
    const turn = await h.cache.getToolsForTurnStart();
    expect(turn.tools).toEqual([...GMAIL_TOOLS]);
    expect(turn.servedStale).toBe(true);
    expect(turn.kickedRefresh).toBe(true);
    expect(h.calls.length).toBeGreaterThan(callsAfterFill);
  });

  it("refresh failure serves stale AND schedules a re-fetch (injected clock)", async () => {
    const h = makeCacheFixture(["gmail"]);
    await h.cache.getTools();

    h.setList("gmail", async () => {
      throw new Error("listTools failed: transport error");
    });
    h.advance(TTL_MS + 1);
    h.calls.length = 0;
    h.tasks.length = 0;

    const turn = await h.cache.getToolsForTurnStart();
    expect(turn.tools).toEqual([...GMAIL_TOOLS]);
    expect(turn.servedStale).toBe(true);
    expect(turn.kickedRefresh).toBe(true);

    const afterFail = await h.cache.getTools();
    expect(afterFail.servedStale).toBe(true);
    expect(afterFail.tools).toEqual([...GMAIL_TOOLS]);
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.tasks.length).toBeGreaterThanOrEqual(1);

    const callsBeforeRetry = h.calls.length;
    h.flush();
    await drain(h.cache.getTools());
    expect(h.calls.length).toBeGreaterThan(callsBeforeRetry);
    const stillStale = await h.cache.getToolsForTurnStart();
    expect(stillStale.tools).toEqual([...GMAIL_TOOLS]);
    expect(stillStale.servedStale).toBe(true);
  });
});

describe("getToolsForTurnStart — never blocks", () => {
  it("cold start returns empty tools and kicks a background refresh", async () => {
    const h = makeCacheFixture(undefined);
    let resolveList: ((tools: readonly string[]) => void) | undefined;
    h.names = undefined;
    h.setList(
      "gmail",
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );

    const turn = await h.cache.getToolsForTurnStart();
    expect(turn.tools).toEqual([]);
    expect(turn.kickedRefresh).toBe(true);
    expect(turn.servedStale).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.tasks.length).toBe(1);

    h.names = ["gmail"];
    h.flush();
    expect(h.calls).toEqual(["gmail"]);
    expect(resolveList).toBeTypeOf("function");
    resolveList?.([...GMAIL_TOOLS]);
    const filled = await h.cache.getTools();
    expect(filled.tools).toEqual([...GMAIL_TOOLS]);
  });

  it("does not wait on a hanging listTools", async () => {
    const h = makeCacheFixture(["gmail"]);
    h.setList("gmail", () => new Promise(() => undefined));

    const started = Date.now();
    const turn = await h.cache.getToolsForTurnStart();
    expect(Date.now() - started).toBeLessThan(200);
    expect(turn.tools).toEqual([]);
    expect(turn.kickedRefresh).toBe(true);
    expect(h.calls).toEqual(["gmail"]);
  });
});

describe("partial-failure policy", () => {
  it("one-server failure degrades that server only", async () => {
    const h = makeCacheFixture(["gmail", "calendar"]);
    h.setList("calendar", async () => {
      throw new Error("listTools failed: HTTP 503");
    });

    const snap = await h.cache.getTools();
    expect(snap.tools).toEqual([...GMAIL_TOOLS]);
    expect(snap.degraded).toEqual(["calendar"]);
    expect(snap.servers).toEqual([
      {
        serverName: "calendar",
        ok: false,
        tools: [],
        error: "listTools failed: HTTP 503",
      },
      {
        serverName: "gmail",
        ok: true,
        tools: [...GMAIL_TOOLS],
      },
    ]);
  });

  it("sole-source failure is an error, not an empty success", async () => {
    const h = makeCacheFixture(["gmail"]);
    h.setList("gmail", async () => {
      throw new Error("listTools failed: HTTP 500");
    });

    await expect(h.cache.getTools()).rejects.toBeInstanceOf(DiscoveryError);
    await expect(h.cache.getTools()).rejects.toMatchObject({
      code: "SOLE_SOURCE_FAILED",
      servers: ["gmail"],
    });
  });

  it("every source failing is an error, not an empty success", async () => {
    const h = makeCacheFixture(["gmail", "calendar"]);
    h.setList("gmail", async () => {
      throw new Error("listTools failed: HTTP 500");
    });
    h.setList("calendar", async () => {
      throw new Error("listTools failed: HTTP 500");
    });

    await expect(h.cache.getTools()).rejects.toMatchObject({
      code: "ALL_SOURCES_FAILED",
    });
  });
});

describe("empty/failed live listing never feeds the allowlist path", () => {
  it("layering constants pin the cache off the allowlist and broker re-check", () => {
    expect(DISCOVERY_CACHE_LAYER.feedsEnumerationReporting).toBe(true);
    expect(DISCOVERY_CACHE_LAYER.feedsAllowlist).toBe(false);
    expect(DISCOVERY_CACHE_LAYER.feedsBrokerRecheck).toBe(false);
  });

  it("discovery-cache source never imports allowedToolsFor or recheckAgainstManifest", () => {
    const source = discoveryCacheSource();
    expect(source).not.toMatch(/from ["'][^"']*allowedTools/);
    expect(source).not.toMatch(/from ["'][^"']*recheck/);
    expect(source).not.toMatch(/from ["']@oikonomos\/broker/);
    expect(source).not.toMatch(/import\s*\{[^}]*allowedToolsFor/);
    expect(source).not.toMatch(/import\s*\{[^}]*recheckAgainstManifest/);
    expect(source).toMatch(/enumeration \/ reporting only/);
  });

  it("empty live listing does not fail-open to the manifest tool set", async () => {
    const h = makeCacheFixture(["gmail"]);
    h.setList("gmail", async () => []);
    const snap = await h.cache.getTools();
    expect(snap.purpose).toBe("enumeration-reporting");
    expect(snap.tools).toEqual([]);
    expect(snap).not.toHaveProperty("allowedTools");

    const report = await enumerateTools(requireManifest(), {
      async listTools() {
        return snap.tools;
      },
    });
    expect(report.ok).toBe(false);
    expect(report.mapped).toEqual([]);
    const allowlist = allowedToolsFor(requireManifest(), report);
    expect(allowlist).toEqual([]);
    expect(allowlist).not.toContain("mcp__gmail__list_messages");
    expect(allowlist).not.toContain("mcp__gmail__create_draft");
    expect(allowlist).not.toContain("mcp__gmail__send_message");
  });

  it("failed live listing throws rather than producing an empty allowlist-shaped success", async () => {
    const h = makeCacheFixture(["gmail"]);
    h.setList("gmail", async () => {
      throw new Error("listTools failed: transport error");
    });

    let thrown: unknown;
    try {
      await h.cache.getTools();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DiscoveryError);
    expect(thrown).toMatchObject({ code: "SOLE_SOURCE_FAILED" });

    const turn = await h.cache.getToolsForTurnStart();
    expect(turn.tools).toEqual([]);
    const report = await enumerateTools(requireManifest(), {
      async listTools() {
        return turn.tools;
      },
    });
    const allowlist = allowedToolsFor(requireManifest(), report);
    expect(allowlist).toEqual([]);
  });

  it("stale extra tools from a failed refresh are not an allowlist", async () => {
    const h = makeCacheFixture(["gmail"]);
    h.setList("gmail", async () => ["mcp__gmail__list_messages", "mcp__gmail__send_message"]);
    await h.cache.getTools();
    h.setList("gmail", async () => {
      throw new Error("listTools failed: transport error");
    });
    h.advance(TTL_MS + 1);

    const stale = await h.cache.getTools();
    expect(stale.servedStale).toBe(true);
    expect(stale.tools).toContain("mcp__gmail__send_message");
    expect(stale).not.toHaveProperty("allowedTools");
    expect(DISCOVERY_CACHE_LAYER.feedsAllowlist).toBe(false);

    const report = await enumerateTools(requireManifest(), {
      async listTools() {
        return [];
      },
    });
    const allowlist = allowedToolsFor(requireManifest(), report);
    expect(allowlist).not.toContain("mcp__gmail__send_message");
  });
});

describe("enumeratorsFrom — TASK-054 adapter seam", () => {
  it("wraps ToolLister records (the live listTools adapter shape)", async () => {
    const bound = enumeratorsFrom({
      gmail: {
        async listTools() {
          return [...GMAIL_TOOLS];
        },
      },
    });
    const cache = createDiscoveryCache({
      ...bound,
      now: () => 1,
      ttlMs: TTL_MS,
      schedule: () => undefined,
    });
    const snap = await cache.getTools();
    expect(snap.tools).toEqual([...GMAIL_TOOLS]);
    expect(snap.purpose).toBe("enumeration-reporting");
  });
});

describe("createDiscoveryCache in front of TASK-054 HTTP listTools adapter", () => {
  it("enumerates through createHttpMcpToolEnumerator with a fake MCP transport", async () => {
    await withMountedMcp(["list_messages", "create_draft"], async (url) => {
      const enumerator = createHttpMcpToolEnumerator("gmail", { transport: "http", url });
      const cache = createDiscoveryCache({
        peekServerNames: () => ["gmail"],
        listTools: (serverName) => {
          if (serverName !== "gmail") {
            return Promise.reject(new Error("listTools failed: unknown server"));
          }
          return enumerator.listTools();
        },
        now: () => 1,
        ttlMs: TTL_MS,
        schedule: () => undefined,
      });
      const snap = await cache.getTools();
      expect(snap.tools).toEqual(["mcp__gmail__list_messages", "mcp__gmail__create_draft"]);
      expect(snap.degraded).toEqual([]);
    });
  });
});

describe("createDiscoveryCache — construction", () => {
  it("rejects a non-positive ttlMs", () => {
    expect(() =>
      createDiscoveryCache({
        peekServerNames: () => ["gmail"],
        listTools: async () => [],
        ttlMs: 0,
      }),
    ).toThrow(RangeError);
  });
});

async function withMountedMcp(
  toolNames: readonly string[],
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
      const method = body.method;
      const id = body.id;
      if (method === "initialize") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "gmail", version: "test" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (method === "tools/list") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" } })),
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
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
