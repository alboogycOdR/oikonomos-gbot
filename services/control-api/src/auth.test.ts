import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { createDatabaseBackedDeps, type ControlApiDeps } from "./ports.js";
import type { DatabaseOptions } from "@oikonomos/db";

import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  createSessionToken,
  isAuthorized,
  isValidLoginToken,
  parseCookieHeader,
  SESSION_COOKIE_NAME,
  verifySessionToken,
  verifyFirebaseIdTokenWithKey,
} from "./auth.js";

const SECRET = "unit-test-fixture-secret";

describe("createSessionToken / verifySessionToken", () => {
  it("a freshly minted token verifies against the same secret", () => {
    const token = createSessionToken(SECRET);
    expect(verifySessionToken(SECRET, token)).toEqual({ tenantId: "basileia", credential: "session" });
  });

  it("rejects a token verified against a different secret", () => {
    const token = createSessionToken(SECRET);
    expect(verifySessionToken("a-different-secret", token)).toBeUndefined();
  });

  it("rejects an expired token", () => {
    const issuedAt = 1_000_000;
    const token = createSessionToken(SECRET, issuedAt);
    // one millisecond after expiry
    expect(verifySessionToken(SECRET, token, issuedAt + 24 * 60 * 60 * 1000 + 1)).toBeUndefined();
  });

  it("accepts a token one millisecond before expiry", () => {
    const issuedAt = 1_000_000;
    const token = createSessionToken(SECRET, issuedAt);
    expect(verifySessionToken(SECRET, token, issuedAt + 24 * 60 * 60 * 1000 - 1)).toEqual({ tenantId: "basileia", credential: "session" });
  });

  it("rejects a malformed token (no separator)", () => {
    expect(verifySessionToken(SECRET, "not-a-valid-token")).toBeUndefined();
  });

  it("rejects a token with a tampered payload (signature no longer matches)", () => {
    const token = createSessionToken(SECRET);
    const [, sig] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ exp: Date.now() + 999_999_999 }), "utf8").toString(
      "base64url",
    );
    expect(verifySessionToken(SECRET, `${tamperedPayload}.${sig}`)).toBeUndefined();
  });

  it("rejects a payload that decodes to non-JSON", () => {
    const garbagePayload = Buffer.from("not json", "utf8").toString("base64url");
    const token = createSessionToken(SECRET);
    const [, sig] = token.split(".");
    expect(verifySessionToken(SECRET, `${garbagePayload}.${sig}`)).toBeUndefined();
  });

  it("rejects an empty string", () => {
    expect(verifySessionToken(SECRET, "")).toBeUndefined();
  });

  it("carries a Firebase UID as the session tenant", () => {
    const token = createSessionToken(SECRET, "firebase-uid-42");
    expect(verifySessionToken(SECRET, token)).toEqual({ tenantId: "firebase-uid-42", credential: "session" });
  });
});

describe("Firebase ID-token verification", () => {
  const projectId = "basileia-oikonomos-gmail";

  async function signedToken(privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"], overrides: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ auth_time: now - 1, ...overrides })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(`https://securetoken.google.com/${projectId}`)
      .setAudience(projectId)
      .setSubject("firebase-user-123")
      .setIssuedAt(now - 1)
      .setExpirationTime(now + 60)
      .sign(privateKey);
  }

  it("verifies an RS256 Firebase-shaped token and returns its UID", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    await expect(verifyFirebaseIdTokenWithKey(await signedToken(privateKey), projectId, publicKey)).resolves.toEqual({ uid: "firebase-user-123" });
  });

  it("rejects a deliberately tampered token and an expired token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await signedToken(privateKey);
    const [header, payload, signature] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: "attacker" }), "utf8").toString("base64url");
    await expect(verifyFirebaseIdTokenWithKey(`${header}.${tamperedPayload}.${signature}`, projectId, publicKey)).rejects.toThrow();
    const expired = await new SignJWT({ auth_time: 1 })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(`https://securetoken.google.com/${projectId}`)
      .setAudience(projectId)
      .setSubject("firebase-user-123")
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(privateKey);
    await expect(verifyFirebaseIdTokenWithKey(expired, projectId, publicKey)).rejects.toThrow();
    const futureIssued = await new SignJWT({ auth_time: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(`https://securetoken.google.com/${projectId}`)
      .setAudience(projectId)
      .setSubject("firebase-user-123")
      .setIssuedAt(Math.floor(Date.now() / 1000) + 60)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 120)
      .sign(privateKey);
    await expect(verifyFirebaseIdTokenWithKey(futureIssued, projectId, publicKey)).rejects.toThrow();
  });
});

describe("POST /auth/google", () => {
  it("mints UID-scoped sessions and keeps two verified users' role lists disjoint", async () => {
    const listRoles = vi.fn(async ({ tenantId }: { tenantId: string }) =>
      tenantId === "firebase-user-a" ? [{ roleId: "a", name: "A", title: "A", description: "A", status: "active", instructions: null }] :
        [{ roleId: "b", name: "B", title: "B", description: "B", status: "active", instructions: null }],
    );
    const app = buildApp({ listRoles } as unknown as ControlApiDeps, {
      authToken: SECRET,
      logger: false,
      verifyFirebaseIdToken: async (idToken) => ({ uid: idToken === "firebase-token-a" ? "firebase-user-a" : "firebase-user-b" }),
    });
    try {
      const loginA = await app.inject({ method: "POST", url: "/auth/google", payload: { idToken: "firebase-token-a" } });
      const loginB = await app.inject({ method: "POST", url: "/auth/google", payload: { idToken: "firebase-token-b" } });
      expect(loginA.statusCode).toBe(200);
      expect(loginB.statusCode).toBe(200);
      const [rolesA, rolesB] = await Promise.all([
        app.inject({ method: "GET", url: "/roles", headers: { cookie: loginA.headers["set-cookie"] } }),
        app.inject({ method: "GET", url: "/roles", headers: { cookie: loginB.headers["set-cookie"] } }),
      ]);
      expect(rolesA.json()).toMatchObject([{ id: "a" }]);
      expect(rolesB.json()).toMatchObject([{ id: "b" }]);
      expect(listRoles).toHaveBeenCalledWith({ tenantId: "firebase-user-a", status: "active" });
      expect(listRoles).toHaveBeenCalledWith({ tenantId: "firebase-user-b", status: "active" });
    } finally {
      await app.close();
    }
  });

  it("rejects a verifier-rejected token with a clear 401 response", async () => {
    const app = buildApp({} as ControlApiDeps, {
      authToken: SECRET,
      logger: false,
      verifyFirebaseIdToken: async () => { throw new Error("signature invalid"); },
    });
    try {
      const response = await app.inject({ method: "POST", url: "/auth/google", payload: { idToken: "tampered" } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid or expired Firebase ID token" });
    } finally {
      await app.close();
    }
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("Firebase UID role isolation against real Postgres", () => {
  it("keeps roles created by two fake-verified UIDs disjoint", async () => {
    const options: DatabaseOptions = { connectionString: connectionString ?? "" };
    const app = buildApp(createDatabaseBackedDeps(options), {
      authToken: SECRET,
      logger: false,
      verifyFirebaseIdToken: async (idToken) => ({ uid: idToken === "token-a" ? "firebase-integration-a" : "firebase-integration-b" }),
    });
    try {
      const loginA = await app.inject({ method: "POST", url: "/auth/google", payload: { idToken: "token-a" } });
      const loginB = await app.inject({ method: "POST", url: "/auth/google", payload: { idToken: "token-b" } });
      const cookieA = loginA.headers["set-cookie"];
      const cookieB = loginB.headers["set-cookie"];
      const createdA = await app.inject({ method: "POST", url: "/roles", headers: { cookie: cookieA }, payload: { name: "Firebase A", description: "A" } });
      const createdB = await app.inject({ method: "POST", url: "/roles", headers: { cookie: cookieB }, payload: { name: "Firebase B", description: "B" } });
      expect(createdA.statusCode).toBe(201);
      expect(createdB.statusCode).toBe(201);
      const [rolesA, rolesB] = await Promise.all([
        app.inject({ method: "GET", url: "/roles", headers: { cookie: cookieA } }),
        app.inject({ method: "GET", url: "/roles", headers: { cookie: cookieB } }),
      ]);
      const createdAId = (createdA.json() as { id: string }).id;
      const createdBId = (createdB.json() as { id: string }).id;
      expect((rolesA.json() as { id: string }[]).map((role) => role.id)).toContain(createdAId);
      expect((rolesA.json() as { id: string }[]).map((role) => role.id)).not.toContain(createdBId);
      expect((rolesB.json() as { id: string }[]).map((role) => role.id)).toContain(createdBId);
      expect((rolesB.json() as { id: string }[]).map((role) => role.id)).not.toContain(createdAId);
    } finally {
      await app.close();
    }
  });
});

describe("parseCookieHeader", () => {
  it("parses multiple cookies separated by '; '", () => {
    expect(parseCookieHeader("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  it("returns an empty object for an undefined header", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it("url-decodes cookie values", () => {
    expect(parseCookieHeader("session=abc%2Bdef")).toEqual({ session: "abc+def" });
  });

  it("ignores malformed segments without '='", () => {
    expect(parseCookieHeader("a=1; garbage; b=2")).toEqual({ a: "1", b: "2" });
  });
});

describe("buildSessionCookie / buildExpiredSessionCookie", () => {
  it("includes HttpOnly, Secure, SameSite=Strict, and the session name", () => {
    const cookie = buildSessionCookie("some-token-value");
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=some-token-value`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("the expired-cookie variant sets Max-Age=0", () => {
    expect(buildExpiredSessionCookie()).toContain("Max-Age=0");
  });
});

describe("isAuthorized", () => {
  it("authorizes a valid bearer token", () => {
    expect(isAuthorized({ authorization: `Bearer ${SECRET}` }, SECRET)).toBe(true);
  });

  it("rejects a missing authorization header and cookie", () => {
    expect(isAuthorized({}, SECRET)).toBe(false);
  });

  it("rejects a wrong bearer token", () => {
    expect(isAuthorized({ authorization: "Bearer wrong" }, SECRET)).toBe(false);
  });

  it("rejects a malformed authorization header (no 'Bearer ' prefix)", () => {
    expect(isAuthorized({ authorization: SECRET }, SECRET)).toBe(false);
  });

  it("authorizes a valid session cookie", () => {
    const token = createSessionToken(SECRET);
    expect(isAuthorized({ cookie: `${SESSION_COOKIE_NAME}=${token}` }, SECRET)).toBe(true);
  });

  it("rejects an invalid session cookie", () => {
    expect(isAuthorized({ cookie: `${SESSION_COOKIE_NAME}=garbage` }, SECRET)).toBe(false);
  });
});

describe("isValidLoginToken", () => {
  it("accepts the correct token", () => {
    expect(isValidLoginToken(SECRET, SECRET)).toBe(true);
  });

  it("rejects an incorrect token", () => {
    expect(isValidLoginToken("wrong", SECRET)).toBe(false);
  });

  it("rejects a token of different length without throwing", () => {
    expect(isValidLoginToken("short", SECRET)).toBe(false);
  });
});
