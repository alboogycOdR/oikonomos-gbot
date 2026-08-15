import { describe, expect, it } from "vitest";

import { bindActionDigest } from "../src/bind.js";
import { verifyAndConsume } from "../src/consume.js";
import { issueApproval } from "../src/issue.js";
import {
  createMemoryStore,
  fixtureAction,
  fixtureRequest,
  grantMemoryRow,
} from "./helpers.js";

describe("verifyAndConsume — digest mismatch invalidates (OIK-023 / CAN-07)", () => {
  it("transitions a granted approval to invalidated when the payload changed", async () => {
    const memory = createMemoryStore();
    const request = fixtureRequest();
    const signal = await issueApproval(request, { store: memory.store });
    memory.rows.set(signal.nonce, grantMemoryRow(memory.rows.get(signal.nonce)!));

    const mutated = fixtureAction({
      input: { to: "eve@example.test", subject: "placeholder subject" },
    });
    expect(
      bindActionDigest({
        toolName: request.toolName,
        input: request.input,
        destination: request.destination,
      }),
    ).not.toBe(bindActionDigest(mutated));

    const result = await verifyAndConsume(signal.nonce, { store: memory.store }, mutated);
    expect(result).toEqual({ consumed: false, rowCount: 0 });
    expect(memory.rows.get(signal.nonce)!.status).toBe("invalidated");
    expect(memory.rows.get(signal.nonce)!.consumedAt).toBeNull();
    expect(memory.events).toEqual(["persist", "invalidate"]);
  });

  it("cannot subsequently be consumed, even with the original matching payload", async () => {
    const memory = createMemoryStore();
    const request = fixtureRequest();
    const signal = await issueApproval(request, { store: memory.store });
    memory.rows.set(signal.nonce, grantMemoryRow(memory.rows.get(signal.nonce)!));

    const mutated = fixtureAction({ destination: "eve@example.test" });
    await verifyAndConsume(signal.nonce, { store: memory.store }, mutated);

    const original = fixtureAction({
      toolName: request.toolName,
      input: request.input,
      destination: request.destination,
    });
    const retry = await verifyAndConsume(signal.nonce, { store: memory.store }, original);
    expect(retry).toEqual({ consumed: false, rowCount: 0 });
    expect(memory.rows.get(signal.nonce)!.status).toBe("invalidated");
  });

  it("still consumes when the recomputed digest matches", async () => {
    const memory = createMemoryStore();
    const request = fixtureRequest();
    const signal = await issueApproval(request, { store: memory.store });
    memory.rows.set(signal.nonce, grantMemoryRow(memory.rows.get(signal.nonce)!));

    const matching = fixtureAction({
      toolName: request.toolName,
      input: { subject: "placeholder subject", to: "review@example.test" },
      destination: request.destination,
    });
    const result = await verifyAndConsume(signal.nonce, { store: memory.store }, matching);
    expect(result.consumed).toBe(true);
    expect(memory.rows.get(signal.nonce)!.status).toBe("consumed");
  });

  it("does not invalidate a still-pending approval on mismatch", async () => {
    const memory = createMemoryStore();
    const signal = await issueApproval(fixtureRequest(), { store: memory.store });

    const result = await verifyAndConsume(
      signal.nonce,
      { store: memory.store },
      fixtureAction({ toolName: "mcp__gmail__send_message" }),
    );
    expect(result).toEqual({ consumed: false, rowCount: 0 });
    expect(memory.rows.get(signal.nonce)!.status).toBe("pending");
    expect(memory.events).toEqual(["persist"]);
  });
});
