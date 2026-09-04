import { describe, expect, it, vi } from "vitest";

import { createConnectorSessionPool } from "../sessions/pool.js";
import {
  GOOGLE_CALENDAR_OAUTH_CLIENT_ID_REF,
  GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET_REF,
  GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN_REF,
} from "./googleCalendarSessionMinter.js";
import { createGoogleCalendarConnectorSessionMinter } from "./googleCalendarSessionMinter.js";
import type { ManifestMcpInput, SecretResolver } from "./types.js";

/** Distinct sentinels assembled at runtime so this file holds no contiguous secret (N4). */
const FAKE_CLIENT_ID = ["fake-client-", "id-not-real"].join("");
const FAKE_CLIENT_SECRET = ["fake-client-", "secret-not-real"].join("");
const FAKE_REFRESH = ["fake-refresh-", "token-not-real"].join("");
const FAKE_ACCESS = ["fake-access-", "token-not-real"].join("");
const FAKE_URL = ["https://", "calendar.example.invalid", "/mcp"].join("");

const MANIFEST: ManifestMcpInput = Object.freeze({
  account_ownership: "basileia",
  mcp_server: { name: "google-calendar", transport: "remote", url_ref: "secret://mcp/google-calendar/url" },
});

function urlResolver(): SecretResolver["resolve"] {
  return async (ref) => {
    if (ref === "secret://mcp/google-calendar/url") return FAKE_URL;
    throw new Error(`unexpected ref: ${ref}`);
  };
}

function oauthSecrets(): Readonly<Record<string, string>> {
  return {
    [GOOGLE_CALENDAR_OAUTH_CLIENT_ID_REF]: FAKE_CLIENT_ID,
    [GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET_REF]: FAKE_CLIENT_SECRET,
    [GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN_REF]: FAKE_REFRESH,
  };
}

function fakeOauthResolve(): SecretResolver["resolve"] {
  const map = oauthSecrets();
  return async (ref) => {
    const value = map[ref];
    if (value === undefined) throw new Error(`unexpected oauth ref: ${ref}`);
    return value;
  };
}

function fakeTokenFetch(accessToken: string): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

describe("createGoogleCalendarConnectorSessionMinter", () => {
  it("produces an McpHttpServerConfig with a bearer token in headers.authorization", async () => {
    const minter = createGoogleCalendarConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: fakeOauthResolve(), fetch: fakeTokenFetch(FAKE_ACCESS) },
    });

    const servers = await minter({ tenantId: "basileia", connectorId: "google-calendar" });

    expect(servers["google-calendar"]).toEqual({
      transport: "http",
      url: FAKE_URL,
      headers: { authorization: `Bearer ${FAKE_ACCESS}` },
    });
  });

  it("respects a custom serverName key", async () => {
    const minter = createGoogleCalendarConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: fakeOauthResolve(), fetch: fakeTokenFetch(FAKE_ACCESS) },
      serverName: "google-calendar-primary",
    });

    const servers = await minter({ tenantId: "basileia", connectorId: "google-calendar" });

    expect(Object.keys(servers)).toEqual(["google-calendar-primary"]);
    expect(servers["google-calendar-primary"]?.transport).toBe("http");
  });

  it("reuses the underlying token provider across mint calls (no repeat oauth secret resolution)", async () => {
    const resolveOauth = vi.fn(fakeOauthResolve());
    const fetchImpl = vi.fn(fakeTokenFetch(FAKE_ACCESS));
    const minter = createGoogleCalendarConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: resolveOauth, fetch: fetchImpl },
    });

    await minter({ tenantId: "basileia", connectorId: "google-calendar" });
    await minter({ tenantId: "basileia", connectorId: "google-calendar" });

    // 3 oauth secrets resolved once each on first mint (token provider built lazily, then cached).
    expect(resolveOauth).toHaveBeenCalledTimes(3);
    // Token exchange itself only happens once too — the provider caches until near-expiry.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("works when passed directly into createConnectorSessionPool({ mint }) — acquire carries the auth header", async () => {
    const minter = createGoogleCalendarConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: fakeOauthResolve(), fetch: fakeTokenFetch(FAKE_ACCESS) },
    });
    const pool = createConnectorSessionPool({ mint: minter });

    const handle = await pool.acquire("basileia", "google-calendar");

    expect(handle.mcpServers["google-calendar"]).toEqual({
      transport: "http",
      url: FAKE_URL,
      headers: { authorization: `Bearer ${FAKE_ACCESS}` },
    });
  });

  it("a mint failure (bad oauth secret) never echoes the missing/attempted secret value", async () => {
    const minter = createGoogleCalendarConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: {
        resolve: async (ref) => {
          if (ref === GOOGLE_CALENDAR_OAUTH_CLIENT_ID_REF) return FAKE_CLIENT_ID;
          if (ref === GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET_REF) return ""; // resolves empty -> throws
          if (ref === GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN_REF) return FAKE_REFRESH;
          throw new Error(`unexpected oauth ref: ${ref}`);
        },
        fetch: fakeTokenFetch(FAKE_ACCESS),
      },
    });

    let thrown: unknown;
    try {
      await minter({ tenantId: "basileia", connectorId: "google-calendar" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const rendered = `${(thrown as Error).message}\n${JSON.stringify(thrown)}\n${(thrown as Error).stack ?? ""}`;
    expect(rendered).not.toContain(FAKE_CLIENT_SECRET);
    expect(rendered).not.toContain(FAKE_REFRESH);
    expect(rendered).not.toContain(FAKE_ACCESS);
  });

  it("rejects when no oauth resolve option is provided (no silent unauthenticated fallback)", async () => {
    const minter = createGoogleCalendarConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
    });

    await expect(minter({ tenantId: "basileia", connectorId: "google-calendar" })).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
