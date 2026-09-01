import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { envSecretResolver } from "./envSecretResolver.js";
import { McpManifestConfigError } from "./errors.js";
import {
  createGmailOAuthTokenProvider,
  createOAuthTokenProvider,
  GMAIL_OAUTH_CLIENT_ID_REF,
  GMAIL_OAUTH_CLIENT_SECRET_REF,
  GMAIL_OAUTH_REFRESH_TOKEN_REF,
  OAuthTokenError,
} from "./oauthTokenProvider.js";
import type { SecretResolver } from "./types.js";

/** Distinct sentinels assembled at runtime so this file holds no contiguous secret (N4). */
const FAKE_CLIENT_ID = ["fake-client-", "id-not-real"].join("");
const FAKE_CLIENT_SECRET = ["fake-client-", "secret-not-real"].join("");
const FAKE_REFRESH = ["fake-refresh-", "token-not-real"].join("");
const FAKE_ACCESS = ["fake-access-", "token-not-real"].join("");
const FAKE_ACCESS_2 = ["fake-access-", "token-rotated"].join("");

function loopbackOrigin(addr: AddressInfo): string {
  return ["http://", addr.address, ":", String(addr.port)].join("");
}

function serialization(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const json = JSON.stringify(err);
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  return `${message}\n${json}\n${stack}`;
}

function assertNoSecret(material: string, ...secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(material).not.toContain(secret);
  }
}

function resolverOf(map: Readonly<Record<string, string>>): SecretResolver["resolve"] {
  return async (ref) => {
    if (!Object.prototype.hasOwnProperty.call(map, ref)) {
      throw new McpManifestConfigError(`secret ref is unset: ${ref}`, "SECRET_UNSET", {
        ref,
        field: "oauth",
      });
    }
    return map[ref] ?? "";
  };
}

type TokenHandler = (fields: URLSearchParams, req: IncomingMessage, res: ServerResponse) => void;

async function withFakeTokenEndpoint(
  handler: TokenHandler,
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
      const raw = Buffer.concat(chunks).toString("utf8");
      const fields = new URLSearchParams(raw);
      handler(fields, req, res);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo;
  const url = `${loopbackOrigin(addr)}/token`;
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

function jsonToken(res: ServerResponse, body: Record<string, unknown>, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

describe("createOAuthTokenProvider — Google token endpoint shape", () => {
  it("exchanges a refresh token for an access token against a local fake endpoint", async () => {
    let hits = 0;
    await withFakeTokenEndpoint((fields, req, res) => {
      hits += 1;
      expect(req.headers["content-type"]).toContain("application/x-www-form-urlencoded");
      expect(fields.get("grant_type")).toBe("refresh_token");
      expect(fields.get("client_id")).toBe(FAKE_CLIENT_ID);
      expect(fields.get("client_secret")).toBe(FAKE_CLIENT_SECRET);
      expect(fields.get("refresh_token")).toBe(FAKE_REFRESH);
      jsonToken(res, {
        access_token: FAKE_ACCESS,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }, async (url) => {
      const provider = createOAuthTokenProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
        refreshToken: FAKE_REFRESH,
        tokenEndpoint: url,
      });
      await expect(provider.getAccessToken()).resolves.toBe(FAKE_ACCESS);
      expect(hits).toBe(1);
    });
  });

  it("uses the Google token host when tokenEndpoint is omitted", async () => {
    const expectedHost = ["oauth2.", "googleapis.com"].join("");
    let seenHost = "";
    const provider = createOAuthTokenProvider({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      refreshToken: FAKE_REFRESH,
      fetch: async (input) => {
        const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seenHost = new URL(href).host;
        return new Response(
          JSON.stringify({ access_token: FAKE_ACCESS, expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(provider.getAccessToken()).resolves.toBe(FAKE_ACCESS);
    expect(seenHost).toBe(expectedHost);
  });
});

describe("createOAuthTokenProvider — cache + injected clock", () => {
  it("reuses the access token until near-expiry, then refreshes transparently", async () => {
    let nowMs = Date.parse("2026-09-01T10:00:00.000Z");
    const tokens = [FAKE_ACCESS, FAKE_ACCESS_2];
    let hits = 0;
    await withFakeTokenEndpoint((_fields, _req, res) => {
      const token = tokens[hits] ?? FAKE_ACCESS_2;
      hits += 1;
      jsonToken(res, { access_token: token, expires_in: 3600, token_type: "Bearer" });
    }, async (url) => {
      const provider = createOAuthTokenProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
        refreshToken: FAKE_REFRESH,
        tokenEndpoint: url,
        now: () => new Date(nowMs),
        expirySkewMs: 60_000,
      });

      await expect(provider.getAccessToken()).resolves.toBe(FAKE_ACCESS);
      expect(hits).toBe(1);

      nowMs += 1_000_000; // +1000s, still inside 3600-60
      await expect(provider.getAccessToken()).resolves.toBe(FAKE_ACCESS);
      expect(hits).toBe(1);

      nowMs += 2_540_000; // total +3540s → near-expiry
      await expect(provider.getAccessToken()).resolves.toBe(FAKE_ACCESS_2);
      expect(hits).toBe(2);

      nowMs += 1_000;
      await expect(provider.getAccessToken()).resolves.toBe(FAKE_ACCESS_2);
      expect(hits).toBe(2);
    });
  });

  it("coalesces concurrent refresh so a cold cache hits the endpoint once", async () => {
    let hits = 0;
    await withFakeTokenEndpoint((_fields, _req, res) => {
      hits += 1;
      jsonToken(res, { access_token: FAKE_ACCESS, expires_in: 3600 });
    }, async (url) => {
      const provider = createOAuthTokenProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
        refreshToken: FAKE_REFRESH,
        tokenEndpoint: url,
      });
      const [a, b] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
      expect(a).toBe(FAKE_ACCESS);
      expect(b).toBe(FAKE_ACCESS);
      expect(hits).toBe(1);
    });
  });
});

describe("createOAuthTokenProvider — typed failures, never a token leak (N4)", () => {
  it("throws TOKEN_EXCHANGE_FAILED on invalid_grant and does not echo secrets", async () => {
    await withFakeTokenEndpoint((_fields, _req, res) => {
      jsonToken(res, { error: "invalid_grant", error_description: FAKE_REFRESH }, 400);
    }, async (url) => {
      const provider = createOAuthTokenProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
        refreshToken: FAKE_REFRESH,
        tokenEndpoint: url,
      });
      try {
        await provider.getAccessToken();
        expect.unreachable("invalid_grant must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthTokenError);
        const named = err as OAuthTokenError;
        expect(named.code).toBe("TOKEN_EXCHANGE_FAILED");
        expect(named.message).toBe("oauth token exchange failed: invalid_grant");
        assertNoSecret(
          serialization(err),
          FAKE_CLIENT_ID,
          FAKE_CLIENT_SECRET,
          FAKE_REFRESH,
          FAKE_ACCESS,
        );
      }
    });
  });

  it("throws NETWORK_ERROR when fetch fails, without interpolating the token", async () => {
    const provider = createOAuthTokenProvider({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      refreshToken: FAKE_REFRESH,
      tokenEndpoint: ["http://", "127.0.0.1", ":1", "/token"].join(""),
      fetch: async () => {
        throw new Error(`connect failed carrying ${FAKE_REFRESH}`);
      },
    });
    try {
      await provider.getAccessToken();
      expect.unreachable("network failure must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthTokenError);
      const named = err as OAuthTokenError;
      expect(named.code).toBe("NETWORK_ERROR");
      expect(named.message).toBe("oauth token exchange failed: network error");
      assertNoSecret(serialization(err), FAKE_REFRESH, FAKE_CLIENT_SECRET);
    }
  });

  it("throws INVALID_RESPONSE when access_token is missing", async () => {
    await withFakeTokenEndpoint((_fields, _req, res) => {
      jsonToken(res, { expires_in: 3600, token_type: "Bearer" });
    }, async (url) => {
      const provider = createOAuthTokenProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
        refreshToken: FAKE_REFRESH,
        tokenEndpoint: url,
      });
      try {
        await provider.getAccessToken();
        expect.unreachable("missing access_token must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthTokenError);
        expect((err as OAuthTokenError).code).toBe("INVALID_RESPONSE");
        assertNoSecret(serialization(err), FAKE_REFRESH, FAKE_CLIENT_SECRET);
      }
    });
  });

  it("rejects empty constructor inputs without storing a value in the message", () => {
    expect(() =>
      createOAuthTokenProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: "",
        refreshToken: FAKE_REFRESH,
      }),
    ).toThrow(OAuthTokenError);
    try {
      createOAuthTokenProvider({
        clientId: FAKE_CLIENT_ID,
        clientSecret: "",
        refreshToken: FAKE_REFRESH,
      });
    } catch (err) {
      expect((err as OAuthTokenError).code).toBe("SECRET_EMPTY");
      expect((err as OAuthTokenError).ref).toBe("client_secret");
      assertNoSecret(serialization(err), FAKE_CLIENT_ID, FAKE_REFRESH);
    }
  });
});

describe("createGmailOAuthTokenProvider — envSecretResolver pattern", () => {
  it("resolves the three Gmail refs and exchanges against the fake endpoint", async () => {
    await withFakeTokenEndpoint((_fields, _req, res) => {
      jsonToken(res, { access_token: FAKE_ACCESS, expires_in: 3600 });
    }, async (url) => {
      const provider = await createGmailOAuthTokenProvider({
        tokenEndpoint: url,
        resolve: resolverOf({
          [GMAIL_OAUTH_CLIENT_ID_REF]: FAKE_CLIENT_ID,
          [GMAIL_OAUTH_CLIENT_SECRET_REF]: FAKE_CLIENT_SECRET,
          [GMAIL_OAUTH_REFRESH_TOKEN_REF]: FAKE_REFRESH,
        }),
      });
      await expect(provider.getAccessToken()).resolves.toBe(FAKE_ACCESS);
    });
  });

  it("throws SECRET_UNSET naming the REF, never a value, when refresh token is missing", async () => {
    try {
      await createGmailOAuthTokenProvider({
        resolve: resolverOf({
          [GMAIL_OAUTH_CLIENT_ID_REF]: FAKE_CLIENT_ID,
          [GMAIL_OAUTH_CLIENT_SECRET_REF]: FAKE_CLIENT_SECRET,
        }),
      });
      expect.unreachable("unset refresh token must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthTokenError);
      const named = err as OAuthTokenError;
      expect(named.code).toBe("SECRET_UNSET");
      expect(named.ref).toBe(GMAIL_OAUTH_REFRESH_TOKEN_REF);
      expect(named.message).toContain(GMAIL_OAUTH_REFRESH_TOKEN_REF);
      assertNoSecret(serialization(err), FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_REFRESH);
    }
  });

  it("maps secret://gmail/oauth/refresh/token through envSecretResolver", async () => {
    const previous = process.env.OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN;
    process.env.OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN = FAKE_REFRESH;
    try {
      await expect(envSecretResolver(GMAIL_OAUTH_REFRESH_TOKEN_REF)).resolves.toBe(FAKE_REFRESH);
    } finally {
      if (previous === undefined) {
        delete process.env.OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN;
      } else {
        process.env.OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN = previous;
      }
    }
  });
});

describe("N4 — no credential or token value in this module or its tests", () => {
  it("assembled sentinels are not contiguous in source, and error paths stay opaque", () => {
    const here = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const impl = readFileSync(fileURLToPath(new URL("./oauthTokenProvider.ts", import.meta.url)), "utf8");
    for (const secret of [FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_REFRESH, FAKE_ACCESS, FAKE_ACCESS_2]) {
      expect(here).not.toContain(secret);
      expect(impl).not.toContain(secret);
    }
    expect(impl).not.toMatch(/ya29\./);
    expect(here).not.toMatch(/ya29\./);
  });
});
