/**
 * TASK-101 / E9.1 — control-api's auth gate. Deliberately minimal: a
 * single shared-secret bearer token (`CONTROL_API_TOKEN`), matching the
 * risk posture of the Telegram gateway's own token gating (one shared
 * credential, not per-user accounts — a full multi-user identity system
 * is out of scope for this task). A browser client cannot practically
 * attach a bearer header to every fetch without re-implementing storage
 * itself, so `POST /auth/login` accepts the same shared token once and
 * issues a signed, expiring httpOnly session cookie as an equivalent
 * credential — never a second secret, never a weaker one.
 *
 * No JWT/cookie library dependency: the session token is a small
 * HMAC-signed structure (`<base64url payload>.<base64url hmac>`), signed
 * with `CONTROL_API_TOKEN` itself as the HMAC key. Only this process
 * (which already holds the token) can mint or verify one.
 *
 * N4: `CONTROL_API_TOKEN` (and the session token derived from it) is
 * never logged and never echoed in a response body anywhere in this
 * file or `app.ts`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "control_api_session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Constant-time string comparison. Unequal lengths are rejected
 * immediately (no secret-dependent branching happens after that point on
 * the equal-length path, which is the only path that can leak timing
 * information about the secret's content).
 */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mint a signed session token bound to an expiry timestamp. The token
 * carries no other claims — this gate has exactly one principal (holder
 * of the shared secret), so there is nothing else to encode.
 */
export function createSessionToken(secret: string, now: number = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ exp }), "utf8").toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * Verify a session token's signature and expiry. Returns `false` for any
 * malformed, forged, or expired token — never throws, so callers can use
 * it directly as an auth gate predicate (fail closed on any parse error).
 */
export function verifySessionToken(secret: string, token: string, now: number = Date.now()): boolean {
  const separatorIndex = token.indexOf(".");
  if (separatorIndex === -1) {
    return false;
  }
  const payload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  if (payload.length === 0 || signature.length === 0) {
    return false;
  }
  if (!safeEqual(signature, sign(secret, payload))) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") {
    return false;
  }
  const exp = (parsed as { exp?: unknown }).exp;
  return typeof exp === "number" && exp > now;
}

/** Parse a raw `Cookie` request header into a name -> value map. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0) {
      out[name] = decodeURIComponent(value);
    }
  }
  return out;
}

/**
 * Build the `Set-Cookie` header value for a fresh session. `HttpOnly` so
 * client JS never sees the token (nonce-adjacent bearer-secret handling
 * discipline); `Secure` so it is never sent over plaintext HTTP;
 * `SameSite=Strict` since this is a same-origin dashboard, not a
 * cross-site integration.
 */
export function buildSessionCookie(token: string): string {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** `Set-Cookie` header value that immediately expires the session cookie (logout). */
export function buildExpiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1];
}

/**
 * The single predicate `app.ts`'s global preHandler calls. Accepts
 * EITHER a valid `Authorization: Bearer <CONTROL_API_TOKEN>` header
 * (scripts, the Telegram gateway's own future admin calls) OR a valid,
 * unexpired session cookie (the browser dashboard, post-`/auth/login`).
 */
export function isAuthorized(
  headers: { authorization?: string; cookie?: string },
  authToken: string,
): boolean {
  const bearer = extractBearerToken(headers.authorization);
  if (bearer !== undefined && safeEqual(bearer, authToken)) {
    return true;
  }
  const cookies = parseCookieHeader(headers.cookie);
  const session = cookies[SESSION_COOKIE_NAME];
  if (session !== undefined && verifySessionToken(authToken, session)) {
    return true;
  }
  return false;
}

/** `POST /auth/login`'s own credential check: the shared token, exactly. */
export function isValidLoginToken(candidate: string, authToken: string): boolean {
  return safeEqual(candidate, authToken);
}
