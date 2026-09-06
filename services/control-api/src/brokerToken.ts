import { createHmac, timingSafeEqual } from "node:crypto";

/** The secret reference is resolved to the matching deployment environment key. */
export const BROKER_TOKEN_SIGNING_KEY_REF = "secret://broker/token_signing_key";
export const BROKER_TOKEN_SIGNING_KEY_ENV = `OIK_SECRET_${BROKER_TOKEN_SIGNING_KEY_REF
  .slice("secret://".length)
  .replaceAll("/", "_")
  .toUpperCase()}`;

export interface BrokerTokenBinding {
  readonly runId: string;
  readonly roleId: string;
  readonly tenantId: string;
  readonly agentRef: {
    readonly provider: string;
    readonly sessionRef: string;
    readonly isSubagent: boolean;
  };
}

export interface VerifiedBrokerToken extends BrokerTokenBinding {
  readonly expiresAt: number;
}

export function resolveBrokerTokenSigningKey(explicitKey?: string): string {
  const key = explicitKey ?? process.env[BROKER_TOKEN_SIGNING_KEY_ENV];
  if (key === undefined || key.trim().length === 0) {
    throw new Error(`${BROKER_TOKEN_SIGNING_KEY_ENV} must be set for broker tokens.`);
  }
  return key;
}

function sign(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function validBinding(binding: BrokerTokenBinding): boolean {
  return [binding.runId, binding.roleId, binding.tenantId, binding.agentRef.provider, binding.agentRef.sessionRef]
    .every((value) => typeof value === "string" && value.trim().length > 0)
    && typeof binding.agentRef.isSubagent === "boolean";
}

/** Mint a short-lived HMAC token whose authenticated identity is the turn binding. */
export function mintBrokerToken(
  binding: BrokerTokenBinding,
  ttlMs: number,
  key?: string,
  now: number = Date.now(),
): string {
  if (!validBinding(binding)) throw new Error("broker token binding is invalid");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("broker token ttlMs must be positive");
  const payload = Buffer.from(JSON.stringify({
    exp: now + ttlMs,
    runId: binding.runId,
    roleId: binding.roleId,
    tenantId: binding.tenantId,
    agentRef: binding.agentRef,
  }), "utf8").toString("base64url");
  return `${payload}.${sign(resolveBrokerTokenSigningKey(key), payload)}`;
}

/** Verify and decode a broker token, failing closed for malformed or expired claims. */
export function verifyBrokerToken(
  token: string,
  key?: string,
  now: number = Date.now(),
): VerifiedBrokerToken | undefined {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) return undefined;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (signature.length === 0 || !equal(signature, sign(resolveBrokerTokenSigningKey(key), payload))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const candidate = parsed as Partial<BrokerTokenBinding> & { exp?: unknown };
  if (typeof candidate.exp !== "number" || candidate.exp <= now) return undefined;
  const binding: BrokerTokenBinding = {
    runId: candidate.runId as string,
    roleId: candidate.roleId as string,
    tenantId: candidate.tenantId as string,
    agentRef: candidate.agentRef as BrokerTokenBinding["agentRef"],
  };
  return validBinding(binding) ? { ...binding, expiresAt: candidate.exp } : undefined;
}
