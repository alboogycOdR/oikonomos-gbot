import { describe, expect, it, vi } from "vitest";
import type { BrokerDependencies, PreToolUseRequest } from "@oikonomos/broker";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import {
  BROKER_PRE_TOOL_USE_PATH,
  buildBrokerHttpApp,
} from "./brokerHttpRoute.js";
import { mintBrokerToken, type BrokerTokenBinding } from "./brokerToken.js";
import type { ControlApiDeps } from "./ports.js";

const SIGNING_KEY = "task-197-broker-key";
const CONTROL_API_TOKEN = "task-197-management-key";
const binding: BrokerTokenBinding = {
  runId: "run-197",
  roleId: "role-197",
  tenantId: "tenant-197",
  agentRef: { provider: "claude", sessionRef: "session-197", isSubagent: false },
};

function token(): string {
  return mintBrokerToken(binding, 60_000, SIGNING_KEY);
}

function request(overrides: Partial<PreToolUseRequest> = {}): PreToolUseRequest {
  return {
    toolUseId: "tool-use-197",
    runId: binding.runId,
    roleId: binding.roleId,
    tenantId: binding.tenantId,
    toolName: "Read",
    input: { file_path: "/tmp/task-197.txt" },
    agentRef: binding.agentRef,
    ...overrides,
  };
}

function dependencies(): BrokerDependencies {
  return {
    isCapabilitiesEnabled: () => true,
    getCapability: async () => ({ toolName: "Read", capabilityId: "fs.read", defaultTier: "T0_observe" }),
    getRoleGrant: async () => ({ maxTier: "T4_irreversible" }),
    destinationFor: (value) => String(value.input.file_path),
    issueApproval: vi.fn(),
    verifyAndConsume: vi.fn(),
    issueApprovalDependencies: {} as BrokerDependencies["issueApprovalDependencies"],
    consumeDependencies: {} as BrokerDependencies["consumeDependencies"],
    recordDecision: vi.fn(async () => ({ eventId: "audit-197" })),
  };
}

async function inject(app: FastifyInstance, body: object, credential = token()) {
  return app.inject({
    method: "POST",
    url: BROKER_PRE_TOOL_USE_PATH,
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

describe("POST /v1/broker/pretooluse (TASK-197)", () => {
  it("uses the real broker handler on the dedicated Fastify app and returns its decision", async () => {
    const deps = dependencies();
    const app = buildBrokerHttpApp({ dependencies: deps, signingKey: SIGNING_KEY });
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("expected broker listener address");
      const response = await fetch(`http://127.0.0.1:${address.port}${BROKER_PRE_TOOL_USE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
        body: JSON.stringify(request()),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ decision: "allow", tier: "T0_observe", auditEventId: "audit-197", toolUseId: "tool-use-197" });
      expect(deps.recordDecision).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("derives identity from the token and denies a mismatched request body", async () => {
    const app = buildBrokerHttpApp({ dependencies: dependencies(), signingKey: SIGNING_KEY });
    try {
      const response = await inject(app, request({ tenantId: "another-tenant" }));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ decision: "deny", reason: "broker.identity_mismatch" });
    } finally {
      await app.close();
    }
  });

  it("rejects an expired token before the broker handler runs", async () => {
    const deps = dependencies();
    const app = buildBrokerHttpApp({ dependencies: deps, signingKey: SIGNING_KEY });
    try {
      const expired = mintBrokerToken(binding, 1, SIGNING_KEY, 0);
      const response = await inject(app, request(), expired);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ decision: "deny", reason: "broker.unauthorized" });
      expect(deps.recordDecision).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects CONTROL_API_TOKEN on the broker listener and broker tokens on management routes", async () => {
    const broker = buildBrokerHttpApp({ dependencies: dependencies(), signingKey: SIGNING_KEY });
    const management = buildApp({} as ControlApiDeps, { authToken: CONTROL_API_TOKEN, logger: false });
    try {
      const brokerResponse = await inject(broker, request(), CONTROL_API_TOKEN);
      expect(brokerResponse.statusCode).toBe(401);
      const managementResponse = await management.inject({
        method: "GET", url: "/tasks", headers: { authorization: `Bearer ${token()}` },
      });
      expect(managementResponse.statusCode).toBe(401);
    } finally {
      await broker.close();
      await management.close();
    }
  });

  it("maps body-limit and rate-limit breaches to deny responses", async () => {
    const app = buildBrokerHttpApp({
      dependencies: dependencies(), signingKey: SIGNING_KEY, bodyLimitBytes: 512, rateLimitMax: 1,
    });
    try {
      const tooLarge = await inject(app, { ...request(), input: { file_path: "x".repeat(1024) } });
      expect(tooLarge.statusCode).toBe(200);
      expect(tooLarge.json()).toMatchObject({ decision: "deny", reason: "broker.malformed_response" });
      const rateCredential = token();
      const first = await inject(app, request({ toolUseId: "rate-one" }), rateCredential);
      expect(first.statusCode).toBe(200);
      const limited = await inject(app, request({ toolUseId: "rate-two" }), rateCredential);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ decision: "deny", reason: "broker.rate_limited" });
    } finally {
      await app.close();
    }
  });

  it("bounds a hung broker call and maps it to BrokerFailure's timeout taxonomy", async () => {
    const app = buildBrokerHttpApp({
      dependencies: dependencies(), signingKey: SIGNING_KEY, timeoutMs: 5,
      handle: async () => await new Promise<never>(() => {}),
    });
    try {
      const response = await inject(app, request());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ decision: "deny", reason: "broker.timeout" });
    } finally {
      await app.close();
    }
  });
});
