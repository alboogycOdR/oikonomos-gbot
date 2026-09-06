import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { issueApproval, verifyAndConsume } from "@oikonomos/approvals";
import { recordDecision } from "@oikonomos/audit";
import {
  BUILTIN_TOOLS,
  BrokerFailure,
  CapabilityRegistry,
  handlePreToolUse,
  type BrokerDependencies,
  type PreToolUseRequest,
  type PreToolUseResponse,
} from "@oikonomos/broker";
import { Database, type DatabaseOptions } from "@oikonomos/db";
import { destinationFor } from "@oikonomos/worker";

import { resolveBrokerTokenSigningKey, verifyBrokerToken, type BrokerTokenBinding } from "./brokerToken.js";

export const BROKER_PRE_TOOL_USE_PATH = "/v1/broker/pretooluse";
export const BROKER_BODY_LIMIT_BYTES = 16 * 1024;
export const BROKER_RATE_LIMIT_MAX = 60;
export const BROKER_RATE_LIMIT_WINDOW_MS = 60_000;
export const BROKER_SERVER_TIMEOUT_MS = 9_000;

export type BrokerHttpResponse = PreToolUseResponse & { readonly toolUseId: string };

export interface BuildBrokerHttpAppOptions {
  readonly signingKey?: string;
  readonly dependencies: BrokerDependencies;
  readonly handle?: typeof handlePreToolUse;
  readonly bodyLimitBytes?: number;
  readonly rateLimitMax?: number;
  readonly rateLimitWindowMs?: number;
  readonly timeoutMs?: number;
  readonly logger?: false;
}

interface RateWindow { readonly startedAt: number; count: number; }

function deny(reason: string, toolUseId = "unavailable"): BrokerHttpResponse {
  return { decision: "deny", reason, auditEventId: "unavailable", toolUseId };
}

function bearer(request: FastifyRequest): string | undefined {
  return /^Bearer\s+(.+)$/.exec(request.headers.authorization ?? "")?.[1];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRequest(value: unknown): value is PreToolUseRequest {
  if (!isObject(value) || !isObject(value.input) || !isObject(value.agentRef)) return false;
  return [value.toolUseId, value.runId, value.roleId, value.tenantId, value.toolName]
    .every((field) => typeof field === "string" && field.trim().length > 0)
    && typeof value.agentRef.provider === "string"
    && value.agentRef.provider.trim().length > 0
    && typeof value.agentRef.sessionRef === "string"
    && value.agentRef.sessionRef.trim().length > 0
    && typeof value.agentRef.isSubagent === "boolean"
    && (value.approvalNonce === undefined || typeof value.approvalNonce === "string");
}

function hasBoundIdentity(request: PreToolUseRequest, binding: BrokerTokenBinding): boolean {
  return request.runId === binding.runId
    && request.roleId === binding.roleId
    && request.tenantId === binding.tenantId
    && request.agentRef.provider === binding.agentRef.provider
    && request.agentRef.sessionRef === binding.agentRef.sessionRef
    && request.agentRef.isSubagent === binding.agentRef.isSubagent;
}

function rateKey(request: FastifyRequest): string {
  // Never retain or log bearer credentials in the limiter map.
  return createHash("sha256").update(bearer(request) ?? request.ip).digest("base64url");
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new BrokerFailure("broker.timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** A dedicated Fastify app: it never shares the management API's listener or auth hook. */
export function buildBrokerHttpApp(options: BuildBrokerHttpAppOptions): FastifyInstance {
  // Refuse to expose a listener that could never authenticate a turn.
  resolveBrokerTokenSigningKey(options.signingKey);
  const bodyLimit = options.bodyLimitBytes ?? BROKER_BODY_LIMIT_BYTES;
  const rateLimitMax = options.rateLimitMax ?? BROKER_RATE_LIMIT_MAX;
  const rateWindowMs = options.rateLimitWindowMs ?? BROKER_RATE_LIMIT_WINDOW_MS;
  const timeoutMs = options.timeoutMs ?? BROKER_SERVER_TIMEOUT_MS;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) throw new Error("broker body limit must be positive");
  if (!Number.isSafeInteger(rateLimitMax) || rateLimitMax <= 0) throw new Error("broker rate limit must be positive");
  if (!Number.isFinite(rateWindowMs) || rateWindowMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("broker time bounds must be positive");
  }
  const app = Fastify({ logger: options.logger ?? false, bodyLimit });
  const windows = new Map<string, RateWindow>();
  const handler = options.handle ?? handlePreToolUse;

  app.setErrorHandler(async (error, request, reply) => {
    const toolUseId = isObject(request.body) && typeof request.body.toolUseId === "string" ? request.body.toolUseId : "unavailable";
    const reason = error instanceof BrokerFailure ? error.reason : "broker.malformed_response";
    await reply.code(200).send(deny(reason, toolUseId));
  });

  app.post(BROKER_PRE_TOOL_USE_PATH, { bodyLimit }, async (request, reply) => {
    const token = bearer(request);
    if (token === undefined) return reply.code(401).send(deny("broker.unauthorized"));
    let verified;
    try {
      verified = verifyBrokerToken(token, options.signingKey);
    } catch {
      // Missing signing configuration must never turn the listener into an allow path.
      return reply.code(503).send(deny("broker.dependency_failure"));
    }
    if (verified === undefined) return reply.code(401).send(deny("broker.unauthorized"));

    const now = Date.now();
    const key = rateKey(request);
    for (const [existingKey, window] of windows) if (now - window.startedAt >= rateWindowMs) windows.delete(existingKey);
    const window = windows.get(key);
    if (window !== undefined && window.count >= rateLimitMax) return reply.code(429).send(deny("broker.rate_limited"));
    if (window === undefined) windows.set(key, { startedAt: now, count: 1 }); else window.count += 1;

    if (!validRequest(request.body)) return reply.code(400).send(deny("broker.malformed_response"));
    if (!hasBoundIdentity(request.body, verified)) return reply.code(403).send(deny("broker.identity_mismatch", request.body.toolUseId));
    const authenticatedRequest: PreToolUseRequest = { ...request.body, ...verified, agentRef: verified.agentRef };
    try {
      const result = await bounded(handler(authenticatedRequest, options.dependencies), timeoutMs);
      return reply.code(200).send({ ...result, toolUseId: authenticatedRequest.toolUseId } satisfies BrokerHttpResponse);
    } catch (error) {
      const reason = error instanceof BrokerFailure ? error.reason : "broker.http_500";
      return reply.code(200).send(deny(reason, authenticatedRequest.toolUseId));
    }
  });
  return app;
}

/** Production DB composition for the dedicated broker listener. */
export async function buildDatabaseBrokerHttpApp(
  databaseOptions: DatabaseOptions,
  options: Omit<BuildBrokerHttpAppOptions, "dependencies"> = {},
): Promise<FastifyInstance> {
  const database = new Database(databaseOptions);
  try {
    const registry = await CapabilityRegistry.build({ declared: BUILTIN_TOOLS, persisted: database });
    const app = buildBrokerHttpApp({
      ...options,
      dependencies: {
        isCapabilitiesEnabled: () => process.env.OIKONOMOS_CAPABILITIES_ENABLED === "true",
        ...registry.brokerPorts(database),
        destinationFor,
        issueApproval,
        verifyAndConsume,
        issueApprovalDependencies: { database: databaseOptions },
        consumeDependencies: { database: databaseOptions },
        recordDecision: async (event) => ({ eventId: (await recordDecision(databaseOptions, event)).eventId }),
      },
    });
    app.addHook("onClose", async () => { await database.close(); });
    return app;
  } catch (error) {
    await database.close();
    throw error;
  }
}
