/**
 * TASK-172 — control-api authentication. Browser users exchange a
 * server-verified Firebase ID token for a signed, expiring httpOnly session
 * cookie. The Firebase UID is the tenant key; email addresses are deliberately
 * not identities. The existing shared CONTROL_API_TOKEN remains a separate
 * service-to-service credential with its documented service tenant.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify, type KeyInput } from "jose";

export const SESSION_COOKIE_NAME = "control_api_session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Tenant used only for trusted scripts and service-to-service calls. */
export const SERVICE_TENANT_ID = "basileia";

export interface AuthPrincipal {
  tenantId: string;
  credential: "bearer" | "session";
}

export interface SessionPrincipal {
  tenantId: string;
  expiresAt: Date;
}

export type FirebaseIdTokenVerifier = (idToken: string) => Promise<{ uid: string }>;

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Mint a signed session token bound to an expiry timestamp and tenant. */
export function createSessionToken(secret: string, tenantIdOrNow: string | number = SERVICE_TENANT_ID, explicitNow?: number): string {
  const tenantId = typeof tenantIdOrNow === "string" ? tenantIdOrNow : SERVICE_TENANT_ID;
  const now = typeof tenantIdOrNow === "number" ? tenantIdOrNow : (explicitNow ?? Date.now());
  if (tenantId.trim().length === 0) throw new Error("session tenantId must not be empty");
  const payload = Buffer.from(JSON.stringify({ exp: now + SESSION_TTL_MS, tenantId }), "utf8").toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

/** Verify a session and return its authenticated principal, failing closed. */
export function verifySessionToken(secret: string, token: string, now: number = Date.now()): AuthPrincipal | undefined {
  const principal = verifySessionPrincipal(secret, token, now);
  return principal === undefined ? undefined : { tenantId: principal.tenantId, credential: "session" };
}

/** Verify a session and retain its expiry for session-status responses. */
export function verifySessionPrincipal(secret: string, token: string, now: number = Date.now()): SessionPrincipal | undefined {
  const separatorIndex = token.indexOf(".");
  if (separatorIndex === -1) return undefined;
  const payload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  if (payload.length === 0 || signature.length === 0 || !safeEqual(signature, sign(secret, payload))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { exp, tenantId } = parsed as { exp?: unknown; tenantId?: unknown };
  if (typeof exp !== "number" || exp <= now || typeof tenantId !== "string" || tenantId.trim().length === 0) return undefined;
  return { tenantId, expiresAt: new Date(exp) };
}

/** Parse a raw Cookie header into a name -> value map. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name.length > 0) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function buildExpiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function extractBearerToken(header: string | undefined): string | undefined {
  return header === undefined ? undefined : /^Bearer\s+(.+)$/.exec(header)?.[1];
}

/** Authenticate a service bearer token or a user session, returning its tenant. */
export function authenticate(headers: { authorization?: string; cookie?: string }, authToken: string): AuthPrincipal | undefined {
  const bearer = extractBearerToken(headers.authorization);
  if (bearer !== undefined && safeEqual(bearer, authToken)) return { tenantId: SERVICE_TENANT_ID, credential: "bearer" };
  const session = parseCookieHeader(headers.cookie)[SESSION_COOKIE_NAME];
  return session === undefined ? undefined : verifySessionToken(authToken, session);
}

export function isAuthorized(headers: { authorization?: string; cookie?: string }, authToken: string): boolean {
  return authenticate(headers, authToken) !== undefined;
}

/** POST /auth/login's own shared-service credential check. */
export function isValidLoginToken(candidate: string, authToken: string): boolean {
  return safeEqual(candidate, authToken);
}

/**
 * Verify Firebase ID tokens using Google's rotating public JWK set. Firebase
 * requires RS256, issuer, audience, expiry, issued-at, and a non-empty
 * subject; jose validates the cryptography and registered claims here.
 */
export function createFirebaseIdTokenVerifier(projectId: string): FirebaseIdTokenVerifier {
  if (projectId.trim().length === 0) throw new Error("Firebase project ID must not be empty");
  const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
  const issuer = `https://securetoken.google.com/${projectId}`;
  return async (idToken: string) => {
    const { payload } = await jwtVerify(idToken, keys, {
      algorithms: ["RS256"], audience: projectId, issuer, typ: "JWT",
    });
    return verifiedFirebaseUid(payload.sub, payload.iat, payload.auth_time);
  };
}

/** The cryptographic verifier, exported so tests exercise the production claim checks with locally-generated keys. */
export async function verifyFirebaseIdTokenWithKey(
  idToken: string,
  projectId: string,
  key: KeyInput,
): Promise<{ uid: string }> {
  const { payload } = await jwtVerify(idToken, key, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
    typ: "JWT",
  });
  return verifiedFirebaseUid(payload.sub, payload.iat, payload.auth_time);
}

function verifiedFirebaseUid(subject: unknown, issuedAt: unknown, authTime: unknown): { uid: string } {
  if (typeof subject !== "string" || subject.trim().length === 0) throw new Error("Firebase ID token is missing a subject");
  if (typeof issuedAt !== "number" || issuedAt > Date.now() / 1000) throw new Error("Firebase ID token has an invalid issued-at time");
  if (typeof authTime !== "number" || authTime > Date.now() / 1000) throw new Error("Firebase ID token has an invalid authentication time");
  return { uid: subject };
}
