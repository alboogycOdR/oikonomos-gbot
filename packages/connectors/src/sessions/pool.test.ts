import { describe, expect, it, vi } from "vitest";

import { createConnectorSessionPool } from "./pool.js";
import { ConnectorSessionPoolError } from "./types.js";
import type { McpServers } from "../mcp/types.js";

const SERVERS: McpServers = Object.freeze({
  gmail: { transport: "http", url: "https://example.invalid/mcp" },
});

function fakeIds(): () => string {
  let n = 0;
  return () => `sess-${(n += 1)}`;
}

describe("createConnectorSessionPool", () => {
  it("mints on first acquire and reuses the same handle thereafter", async () => {
    const mint = vi.fn().mockResolvedValue(SERVERS);
    const pool = createConnectorSessionPool({ mint, generateSessionId: fakeIds() });

    const first = await pool.acquire("basileia", "gmail");
    const second = await pool.acquire("basileia", "gmail");

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({ tenantId: "basileia", connectorId: "gmail" });
    expect(second).toBe(first);
    expect(second.sessionId).toBe("sess-1");
  });

  it("scopes sessions by (tenant, connector) — no cross-tenant reuse", async () => {
    const mint = vi.fn().mockResolvedValue(SERVERS);
    const pool = createConnectorSessionPool({ mint, generateSessionId: fakeIds() });

    const tenantA = await pool.acquire("basileia", "gmail");
    const tenantB = await pool.acquire("other-tenant", "gmail");

    expect(tenantA.sessionId).not.toBe(tenantB.sessionId);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(2);
  });

  it("survives release without tearing the session down (acquire/release, not create/destroy)", async () => {
    const mint = vi.fn().mockResolvedValue(SERVERS);
    const pool = createConnectorSessionPool({ mint, generateSessionId: fakeIds() });

    const handle = await pool.acquire("basileia", "gmail");
    pool.release(handle);
    const reacquired = await pool.acquire("basileia", "gmail");

    expect(mint).toHaveBeenCalledTimes(1);
    expect(reacquired).toBe(handle);
    expect(pool.size).toBe(1);
  });

  it("re-mints transparently once a session has expired, with no observable failure", async () => {
    let now = 0;
    const mint = vi.fn().mockResolvedValue(SERVERS);
    const pool = createConnectorSessionPool({
      mint,
      generateSessionId: fakeIds(),
      ttlMs: 1000,
      now: () => new Date(now),
    });

    const first = await pool.acquire("basileia", "gmail");
    now = 1000;
    const second = await pool.acquire("basileia", "gmail");

    expect(mint).toHaveBeenCalledTimes(2);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.sessionId).toBe("sess-2");
  });

  it("release is a safe no-op for a handle superseded by re-mint or never acquired here", async () => {
    const mint = vi.fn().mockResolvedValue(SERVERS);
    const pool = createConnectorSessionPool({ mint, generateSessionId: fakeIds() });

    const stale: Parameters<typeof pool.release>[0] = {
      sessionId: "not-a-real-session",
      tenantId: "basileia",
      connectorId: "gmail",
      mcpServers: SERVERS,
    };

    expect(() => pool.release(stale)).not.toThrow();
    expect(pool.size).toBe(0);
  });

  it("rejects empty tenantId / connectorId inputs", async () => {
    const mint = vi.fn().mockResolvedValue(SERVERS);
    const pool = createConnectorSessionPool({ mint });

    await expect(pool.acquire("", "gmail")).rejects.toThrow(ConnectorSessionPoolError);
    await expect(pool.acquire("basileia", "  ")).rejects.toThrow(ConnectorSessionPoolError);
  });

  it("wraps a minter failure in ConnectorSessionPoolError without leaking mint internals as a different type", async () => {
    const mint = vi.fn().mockRejectedValue(new Error("oauth exchange failed"));
    const pool = createConnectorSessionPool({ mint });

    await expect(pool.acquire("basileia", "gmail")).rejects.toMatchObject({
      name: "ConnectorSessionPoolError",
      code: "MINT_FAILED",
    });
  });

  it("never returns a token/url/header field on the handle beyond the minted mcpServers config", async () => {
    const mint = vi.fn().mockResolvedValue(SERVERS);
    const pool = createConnectorSessionPool({ mint, generateSessionId: fakeIds() });

    const handle = await pool.acquire("basileia", "gmail");

    expect(Object.keys(handle).sort()).toEqual(
      ["connectorId", "mcpServers", "sessionId", "tenantId"].sort(),
    );
    expect(handle.mcpServers).toBe(SERVERS);
  });
});
