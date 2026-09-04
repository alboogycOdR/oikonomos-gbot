import { describe, expect, it, vi } from "vitest";

import { createConnectorSessionPool } from "../sessions/pool.js";
import {
  createGoogleDriveConnectorSessionMinter,
  GOOGLE_DRIVE_OAUTH_CLIENT_ID_REF,
  GOOGLE_DRIVE_OAUTH_CLIENT_SECRET_REF,
  GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN_REF,
} from "./googleDriveSessionMinter.js";
import type { ManifestMcpInput, SecretResolver } from "./types.js";

/** Distinct sentinels assembled at runtime so this file holds no contiguous secret (N4). */
const FAKE_CLIENT_ID = ["fake-client-", "id-not-real"].join("");
const FAKE_CLIENT_SECRET = ["fake-client-", "secret-not-real"].join("");
const FAKE_REFRESH = ["fake-refresh-", "token-not-real"].join("");
const FAKE_ACCESS = ["fake-access-", "token-not-real"].join("");
const FAKE_URL = ["https://", "drive.example.invalid", "/mcp"].join("");

const MANIFEST: ManifestMcpInput = Object.freeze({
  account_ownership: "basileia",
  mcp_server: { name: "google-drive", transport: "remote", url_ref: "secret://mcp/google-drive/url" },
});

function urlResolver(): SecretResolver["resolve"] {
  return async (ref) => {
    if (ref === "secret://mcp/google-drive/url") return FAKE_URL;
    throw new Error(`unexpected ref: ${ref}`);
  };
}

function oauthSecrets(): Readonly<Record<string, string>> {
  return {
    [GOOGLE_DRIVE_OAUTH_CLIENT_ID_REF]: FAKE_CLIENT_ID,
    [GOOGLE_DRIVE_OAUTH_CLIENT_SECRET_REF]: FAKE_CLIENT_SECRET,
    [GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN_REF]: FAKE_REFRESH,
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

describe("createGoogleDriveConnectorSessionMinter", () => {
  it("produces an McpHttpServerConfig with a bearer token in headers.authorization", async () => {
    const minter = createGoogleDriveConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: fakeOauthResolve(), fetch: fakeTokenFetch(FAKE_ACCESS) },
    });

    const servers = await minter({ tenantId: "basileia", connectorId: "google-drive" });

    expect(servers["google-drive"]).toEqual({
      transport: "http",
      url: FAKE_URL,
      headers: { authorization: `Bearer ${FAKE_ACCESS}` },
    });
  });

  it("reuses the underlying token provider across mint calls", async () => {
    const resolveOauth = vi.fn(fakeOauthResolve());
    const fetchImpl = vi.fn(fakeTokenFetch(FAKE_ACCESS));
    const minter = createGoogleDriveConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: resolveOauth, fetch: fetchImpl },
    });

    await minter({ tenantId: "basileia", connectorId: "google-drive" });
    await minter({ tenantId: "basileia", connectorId: "google-drive" });

    expect(resolveOauth).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("works when passed directly into createConnectorSessionPool({ mint })", async () => {
    const minter = createGoogleDriveConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: { resolve: fakeOauthResolve(), fetch: fakeTokenFetch(FAKE_ACCESS) },
    });
    const pool = createConnectorSessionPool({ mint: minter });

    const handle = await pool.acquire("basileia", "google-drive");

    expect(handle.mcpServers["google-drive"]).toEqual({
      transport: "http",
      url: FAKE_URL,
      headers: { authorization: `Bearer ${FAKE_ACCESS}` },
    });
  });

  it("does not echo resolved OAuth values when OAuth secret resolution fails", async () => {
    const minter = createGoogleDriveConnectorSessionMinter({
      manifest: MANIFEST,
      resolveUrl: urlResolver(),
      oauth: {
        resolve: async (ref) => {
          if (ref === GOOGLE_DRIVE_OAUTH_CLIENT_ID_REF) return FAKE_CLIENT_ID;
          if (ref === GOOGLE_DRIVE_OAUTH_CLIENT_SECRET_REF) return "";
          if (ref === GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN_REF) return FAKE_REFRESH;
          throw new Error(`unexpected oauth ref: ${ref}`);
        },
        fetch: fakeTokenFetch(FAKE_ACCESS),
      },
    });

    const thrown = await Promise.resolve(minter({ tenantId: "basileia", connectorId: "google-drive" })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const rendered = `${(thrown as Error).message}\n${JSON.stringify(thrown)}\n${(thrown as Error).stack ?? ""}`;
    expect(rendered).not.toContain(FAKE_CLIENT_SECRET);
    expect(rendered).not.toContain(FAKE_REFRESH);
    expect(rendered).not.toContain(FAKE_ACCESS);
  });
});
