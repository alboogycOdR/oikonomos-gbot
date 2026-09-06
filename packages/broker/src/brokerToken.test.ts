import { describe, expect, it } from "vitest";

import { BROKER_TOKEN_SIGNING_KEY_ENV, BROKER_TOKEN_SIGNING_KEY_REF, mintBrokerToken, verifyBrokerToken, type BrokerTokenBinding } from "./brokerToken.js";

const KEY = "task-170-signing-key";
const binding: BrokerTokenBinding = {
  runId: "run-170", roleId: "role-170", tenantId: "tenant-170",
  agentRef: { provider: "claude", sessionRef: "session-170", isSubagent: false },
};

describe("broker per-turn tokens (TASK-170)", () => {
  it("uses the documented secret reference convention", () => {
    expect(BROKER_TOKEN_SIGNING_KEY_REF).toBe("secret://broker/token_signing_key");
    expect(BROKER_TOKEN_SIGNING_KEY_ENV).toBe("OIK_SECRET_BROKER_TOKEN_SIGNING_KEY");
  });
  it("round-trips the full identity binding", () => {
    const token = mintBrokerToken(binding, 1_000, KEY, 10);
    expect(verifyBrokerToken(token, KEY, 999)).toEqual({ ...binding, expiresAt: 1_010 });
  });
  it("fails closed when expired, tampered, or signed with another key", () => {
    const token = mintBrokerToken(binding, 10, KEY, 10);
    expect(verifyBrokerToken(token, KEY, 20)).toBeUndefined();
    expect(verifyBrokerToken(`${token}x`, KEY, 11)).toBeUndefined();
    expect(verifyBrokerToken(token, "other-key", 11)).toBeUndefined();
  });
});
