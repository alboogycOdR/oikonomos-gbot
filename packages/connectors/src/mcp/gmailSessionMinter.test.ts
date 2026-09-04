import { describe, expect, it, vi } from "vitest";

import { createConnectorSessionPool } from "../sessions/pool.js";
import { GMAIL_OAUTH_CLIENT_ID_REF, GMAIL_OAUTH_CLIENT_SECRET_REF, GMAIL_OAUTH_REFRESH_TOKEN_REF } from "./oauthTokenProvider.js";
import { createGmailConnectorSessionMinter } from "./gmailSessionMinter.js";
import type { ManifestMcpInput, SecretResolver } from "./types.js";

/** Distinct sentinels assembled at runtime so this file holds no contiguous secret (N4). */
const FAKE_CLIENT_ID = ["fake-client-", "id-not-real"].join("");
const FAKE_CLIENT_SECRET = ["fake-client-", "secret-not-real"].join("");
const FAKE_REFRESH = ["fake-refresh-", "token-not-real"].join("");
const FAKE_ACCESS = ["fake-access-", "token-not-real"].join("");
const FAKE_URL = ["https://", "gmail.example.invalid", "/mcp"].join("");

const MANIFEST: ManifestMcpInput = Object.freeze({
  account_ownership: "basileia",
  mcp_server: { name: "gmail", transport: "remote", url_ref: "secret://mcp/gmail/url" },
});

function urlResolver(): SecretResolver["resolve"] {
  return async (ref) => {
    if (ref === "secret://mcp/gmail/url") return FAKE_URL;
    throw new Error(`unexpected ref: ${ref}`);
  };
}

function oauthSecrets(): Readonly<Record<string, string>> {
  return {
    [GMAIL_OAUTH_CLIENT_ID_REF]: FAKE_CLIENT_ID,
    [GMAIL_OAUTH_CLIENT_SECRET_REF]: FAKE_CLIENT_SECRET,
    [GMAIL_OAUTH_REFRESH_TOKEN_REF]: FAKE_REFRESH,
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

describe("createGmailConnectorSessionMinter", () => {
  it("produces an McpHttpServerConfig with a bearer token in headers.authorization", async () => {
    const minter = createGmailConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: fakeOauthResolve(), fetch: fakeTokenFetch(FAKE_ACCESS) },
    });

    const servers = await minter({ tenantId: "basileia", connectorId: "gmail" });

    expect(servers.gmail).toEqual({
      transport: "http",
      url: FAKE_URL,
      headers: { authorization: `Bearer ${FAKE_ACCESS}` },
    });
  });

  it("respects a custom serverName key", async () => {
    const minter = createGmailConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: fakeOauthResolve(), fetch: fakeTokenFetch(FAKE_ACCESS) },
      serverName: "gmail-primary",
    });

    const servers = await minter({ tenantId: "basileia", connectorId: "gmail" });

    expect(Object.keys(servers)).toEqual(["gmail-primary"]);
    expect(servers["gmail-primary"]?.transport).toBe("http");
  });

  it("reuses the underlying token provider across mint calls (no repeat oauth secret resolution)", async () => {
    const resolveOauth = vi.fn(fakeOauthResolve());
    const fetchImpl = vi.fn(fakeTokenFetch(FAKE_ACCESS));
    const minter = createGmailConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: resolveOauth, fetch: fetchImpl },
    });

    await minter({ tenantId: "basileia", connectorId: "gmail" });
    await minter({ tenantId: "basileia", connectorId: "gmail" });

    // 3 oauth secrets resolved once each on first mint (token provider built lazily, then cached).
    expect(resolveOauth).toHaveBeenCalledTimes(3);
    // Token exchange itself only happens once too — the provider caches until near-expiry.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("works when passed directly into createConnectorSessionPool({ mint }) — acquire carries the auth header", async () => {
    const minter = createGmailConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: fakeOauthResolve(), fetch: fakeTokenFetch(FAKE_ACCESS) },
    });
    const pool = createConnectorSessionPool({ mint: minter });

    const handle = await pool.acquire("basileia", "gmail");

    expect(handle.mcpServers.gmail).toEqual({
      transport: "http",
      url: FAKE_URL,
      headers: { authorization: `Bearer ${FAKE_ACCESS}` },
    });
  });

  it("a mint failure (bad oauth secret) never echoes the missing/attempted secret value", async () => {
    const minter = createGmailConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: {
        resolve: async (ref) => {
          if (ref === GMAIL_OAUTH_CLIENT_ID_REF) return FAKE_CLIENT_ID;
          if (ref === GMAIL_OAUTH_CLIENT_SECRET_REF) return ""; // resolves empty -> SECRET_EMPTY
          if (ref === GMAIL_OAUTH_REFRESH_TOKEN_REF) return FAKE_REFRESH;
          throw new Error(`unexpected oauth ref: ${ref}`);
        },
        fetch: fakeTokenFetch(FAKE_ACCESS),
      },
    });

    let thrown: unknown;
    try {
      await minter({ tenantId: "basileia", connectorId: "gmail" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const rendered = `${(thrown as Error).message}\n${JSON.stringify(thrown)}\n${(thrown as Error).stack ?? ""}`;
    expect(rendered).not.toContain(FAKE_CLIENT_SECRET);
    expect(rendered).not.toContain(FAKE_REFRESH);
    expect(rendered).not.toContain(FAKE_ACCESS);
  });
});
