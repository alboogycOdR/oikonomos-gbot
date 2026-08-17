import { describe, expect, it, vi } from "vitest";

import { canaryCompose, invokeL1, permissionDecision, sendInput, TIER3_TOOL } from "./helpers.js";

/** ADR-001 R3 — hook timeout is 10s; asserted here so the canary does not import the L1 adapter. */
const BROKER_TIMEOUT_MS = 10_000;

describe("CAN-04 — broker 500 / timeout fail closed and park", () => {
  it("HTTP 500 denies the tool, parks the run, and does not execute", async () => {
    const { composed, park } = canaryCompose({
      broker: {
        baseUrl: "http://broker.example",
        fetch: async () => new Response("nope", { status: 500 }),
      },
    });

    const result = await invokeL1(composed, TIER3_TOOL, "can-04-500", sendInput());
    const mapped = permissionDecision(result);

    expect(mapped.decision).toBe("deny");
    expect(mapped.reason).toBe("broker.http_500");
    expect(park.parks).toEqual([{ toolUseId: "can-04-500", reason: "broker.http_500" }]);
  });

  it("timeout denies the tool, parks the run, and does not execute", async () => {
    vi.useFakeTimers();
    try {
      const { composed, park } = canaryCompose({
        broker: {
          baseUrl: "http://broker.example",
          fetch: (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                const err = new Error("This operation was aborted");
                err.name = "AbortError";
                reject(err);
              });
            }),
        },
      });

      const pending = invokeL1(composed, TIER3_TOOL, "can-04-timeout", sendInput());
      await vi.advanceTimersByTimeAsync(BROKER_TIMEOUT_MS);
      const mapped = permissionDecision(await pending);

      expect(mapped.decision).toBe("deny");
      expect(mapped.reason).toBe("broker.timeout");
      expect(park.parks).toEqual([{ toolUseId: "can-04-timeout", reason: "broker.timeout" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
