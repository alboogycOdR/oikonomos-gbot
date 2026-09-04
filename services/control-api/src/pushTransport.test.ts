import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CollectingPushTransport, DisabledPushTransport, FcmHttpPushTransport, createPushTransportFromEnv, type FetchLike } from "./pushTransport.js";

describe("push transports (TASK-145)", () => {
  it("uses a disabled transport when FCM configuration is absent", async () => {
    const transport = createPushTransportFromEnv({});
    expect(transport).toBeInstanceOf(DisabledPushTransport);
    await expect(transport.send("opaque-target", { type: "run-completed", runId: "run-1" })).resolves.toBeUndefined();
  });

  it("sends OAuth then FCM HTTP requests through an injected fetch", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? new Response(JSON.stringify({ access_token: "short-lived-access" }), { status: 200 })
        : new Response("{}", { status: 200 });
    };
    const transport = new FcmHttpPushTransport({
      project_id: "test-project",
      client_email: "test@example.invalid",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: "https://auth.invalid/token",
    }, fetchFn, () => 1_700_000_000_000);

    await transport.send("opaque-target", { type: "approval-pending", runId: "run-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://auth.invalid/token");
    expect(calls[1]?.url).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ message: { token: "opaque-target", data: { type: "approval-pending", runId: "run-1" } } }));
  });

  it("collects sends for route/composition tests", async () => {
    const transport = new CollectingPushTransport();
    await transport.send("opaque-target", { type: "run-completed", runId: "run-1" });
    expect(transport.sends).toEqual([{ deviceToken: "opaque-target", notification: { type: "run-completed", runId: "run-1" } }]);
  });
});
