/**
 * L1 PreToolUse adapter (OIK-034 / ADR-001 P1).
 *
 * POSTs each tool call to POST /v1/broker/pretooluse via an injected HTTP
 * port. Maps Handover §4.1 allow/deny; fails closed on transport failure,
 * timeout >10s, or an unparseable body (R3 / CAN-04).
 *
 * Does not own the §4.1 TypeScript contract, canonical JSON, or action
 * digest — those live in @oikonomos/broker and @oikonomos/shared. This file
 * only forwards hook + run identity and maps the broker's reply.
 */

import type {
  PreToolUseHookPort,
  PreToolUsePortDecision,
  PreToolUsePortRequest,
} from "../ports.js";

/** Handover §4.1 path. Kept here so L3 (OIK-035) can share the same string. */
export const BROKER_PRETOOLUSE_PATH = "/v1/broker/pretooluse";

/** ADR-001 R3: hook timeout is 10 s for Tier 0–2. */
export const BROKER_TIMEOUT_MS = 10_000;

export interface L1RunIdentity {
  runId: string;
  roleId: string;
  tenantId: string;
  agentRef: { provider: string; sessionRef: string; isSubagent: boolean };
}

/**
 * Injected broker transport. The composition root supplies fetch + base URL
 * (real client or test double). This adapter does not construct a second
 * broker implementation.
 */
export interface BrokerHttpPort {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
}

export interface L1PreToolUseHookOptions {
  broker: BrokerHttpPort;
  run: L1RunIdentity;
  /** Present only on an approved retry (Handover §4.1). */
  approvalNonceFor?: (request: PreToolUsePortRequest) => string | undefined;
}

export function createL1PreToolUseHook(options: L1PreToolUseHookOptions): PreToolUseHookPort {
  assertOptions(options);
  const { broker, run, approvalNonceFor } = options;

  return {
    async handle(request: PreToolUsePortRequest): Promise<PreToolUsePortDecision> {
      if (!request.toolUseId || !request.toolName) {
        return failClosed("broker.malformed_response");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS);

      try {
        const url = brokerUrl(broker.baseUrl);
        const body = JSON.stringify(
          brokerRequestBody(request, run, approvalNonceFor?.(request)),
        );
        const response = await broker.fetch(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body,
          signal: controller.signal,
        });
        return mapBrokerHttpResponse(response);
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) {
          return failClosed("broker.timeout");
        }
        return failClosed("broker.unreachable");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function assertOptions(options: L1PreToolUseHookOptions): void {
  if (typeof options?.broker?.fetch !== "function") {
    throw new Error("L1 requires an injected broker fetch port");
  }
  if (typeof options.broker.baseUrl !== "string" || options.broker.baseUrl.length === 0) {
    throw new Error("L1 requires broker.baseUrl");
  }
  const { run } = options;
  if (!run?.runId || !run.roleId || !run.tenantId) {
    throw new Error("L1 run identity is incomplete");
  }
  if (
    !run.agentRef ||
    typeof run.agentRef.provider !== "string" ||
    run.agentRef.provider.length === 0 ||
    typeof run.agentRef.sessionRef !== "string" ||
    run.agentRef.sessionRef.length === 0 ||
    typeof run.agentRef.isSubagent !== "boolean"
  ) {
    throw new Error("L1 agentRef is incomplete");
  }
}

function brokerUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${BROKER_PRETOOLUSE_PATH}`;
}

/**
 * Wire fields for the injected POST. Not a second §4.1 type export — field
 * names are the broker contract consumed at the HTTP seam.
 */
function brokerRequestBody(
  request: PreToolUsePortRequest,
  run: L1RunIdentity,
  approvalNonce: string | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    toolUseId: request.toolUseId,
    runId: run.runId,
    roleId: run.roleId,
    tenantId: run.tenantId,
    toolName: request.toolName,
    input: request.input,
    agentRef: {
      provider: run.agentRef.provider,
      sessionRef: run.agentRef.sessionRef,
      isSubagent: run.agentRef.isSubagent,
    },
  };
  if (typeof approvalNonce === "string" && approvalNonce.length > 0) {
    body.approvalNonce = approvalNonce;
  }
  return body;
}

async function mapBrokerHttpResponse(response: Response): Promise<PreToolUsePortDecision> {
  if (!response.ok) {
    return failClosed(response.status >= 500 ? "broker.http_500" : "broker.unreachable");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return failClosed("broker.malformed_response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return failClosed("broker.malformed_response");
  }

  return mapBrokerDecision(parsed);
}

function mapBrokerDecision(parsed: unknown): PreToolUsePortDecision {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failClosed("broker.malformed_response");
  }

  const record = parsed as Record<string, unknown>;
  if (record.decision === "allow") {
    if (!("updatedInput" in record) || record.updatedInput === undefined) {
      return { decision: "allow" };
    }
    if (!isPlainObject(record.updatedInput)) {
      return failClosed("broker.malformed_response");
    }
    return { decision: "allow", updatedInput: record.updatedInput };
  }

  if (record.decision === "deny") {
    if (typeof record.reason !== "string" || record.reason.length === 0) {
      return failClosed("broker.malformed_response");
    }
    return { decision: "deny", message: record.reason };
  }

  return failClosed("broker.malformed_response");
}

function failClosed(message: string): PreToolUsePortDecision {
  return { decision: "deny", message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  );
}
