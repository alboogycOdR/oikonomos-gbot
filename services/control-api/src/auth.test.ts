import { describe, expect, it } from "vitest";

import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  createSessionToken,
  isAuthorized,
  isValidLoginToken,
  parseCookieHeader,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "./auth.js";

const SECRET = "unit-test-fixture-secret";

describe("createSessionToken / verifySessionToken", () => {
  it("a freshly minted token verifies against the same secret", () => {
    const token = createSessionToken(SECRET);
    expect(verifySessionToken(SECRET, token)).toBe(true);
  });

  it("rejects a token verified against a different secret", () => {
    const token = createSessionToken(SECRET);
    expect(verifySessionToken("a-different-secret", token)).toBe(false);
  });

  it("rejects an expired token", () => {
    const issuedAt = 1_000_000;
    const token = createSessionToken(SECRET, issuedAt);
    // one millisecond after expiry
    expect(verifySessionToken(SECRET, token, issuedAt + 24 * 60 * 60 * 1000 + 1)).toBe(false);
  });

  it("accepts a token one millisecond before expiry", () => {
    const issuedAt = 1_000_000;
    const token = createSessionToken(SECRET, issuedAt);
    expect(verifySessionToken(SECRET, token, issuedAt + 24 * 60 * 60 * 1000 - 1)).toBe(true);
  });

  it("rejects a malformed token (no separator)", () => {
    expect(verifySessionToken(SECRET, "not-a-valid-token")).toBe(false);
  });

  it("rejects a token with a tampered payload (signature no longer matches)", () => {
    const token = createSessionToken(SECRET);
    const [, sig] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ exp: Date.now() + 999_999_999 }), "utf8").toString(
      "base64url",
    );
    expect(verifySessionToken(SECRET, `${tamperedPayload}.${sig}`)).toBe(false);
  });

  it("rejects a payload that decodes to non-JSON", () => {
    const garbagePayload = Buffer.from("not json", "utf8").toString("base64url");
    const token = createSessionToken(SECRET);
    const [, sig] = token.split(".");
    expect(verifySessionToken(SECRET, `${garbagePayload}.${sig}`)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(verifySessionToken(SECRET, "")).toBe(false);
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
