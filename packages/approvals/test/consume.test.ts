import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { consumeApproval } from "@oikonomos/db";

import { verifyAndConsume } from "../src/consume.js";
import type { ApprovalStore, ConsumeApprovalResult } from "../src/store.js";
import { createMemoryStore, fixtureRequest, grantMemoryRow } from "./helpers.js";
import { issueApproval } from "../src/issue.js";

describe("verifyAndConsume — row count gates the action", () => {
  it("allows the action only when consume returns rowCount 1", async () => {
    const memory = createMemoryStore();
    const signal = await issueApproval(fixtureRequest(), { store: memory.store });
    const pending = memory.rows.get(signal.nonce);
    expect(pending).toBeDefined();
    memory.rows.set(signal.nonce, grantMemoryRow(pending!));

    const first = await verifyAndConsume(signal.nonce, { store: memory.store });
    expect(first.consumed).toBe(true);
    if (!first.consumed) {
      throw new Error("expected consume to succeed");
    }
    expect(first.rowCount).toBe(1);
    expect(first.approval.status).toBe("consumed");
    expect(first.approval.consumedAt).not.toBeNull();
    expect(memory.events).toEqual(["persist", "consume"]);
  });

  it("denies when the store reports rowCount 0 — the action must not run", async () => {
    let consumeCalls = 0;
    const store: ApprovalStore = {
      insert: async () => {
        throw new Error("insert must not run");
      },
      getByNonce: async () => null,
      consume: async (): Promise<ConsumeApprovalResult> => {
        consumeCalls += 1;
        return { rowCount: 0, approval: null };
      },
      invalidate: async () => ({ rowCount: 0, approval: null }),
      expirePending: async () => 0,
    };

    const result = await verifyAndConsume(randomUUID(), { store });
    expect(result).toEqual({ consumed: false, rowCount: 0 });
    expect(consumeCalls).toBe(1);
  });

  it("fails closed if a store claims rowCount 1 without a consumed row", async () => {
    const store: ApprovalStore = {
      insert: async () => {
        throw new Error("insert must not run");
      },
      getByNonce: async () => null,
      consume: async () => ({ rowCount: 1, approval: null }),
      invalidate: async () => ({ rowCount: 0, approval: null }),
      expirePending: async () => 0,
    };

    await expect(verifyAndConsume(randomUUID(), { store })).rejects.toThrow(/rowCount/);
  });
});

describe("verifyAndConsume — replay and expiry at the service boundary", () => {
  it("denies replay of a consumed nonce and leaves status consumed", async () => {
    const memory = createMemoryStore();
    const signal = await issueApproval(fixtureRequest(), { store: memory.store });
    memory.rows.set(signal.nonce, grantMemoryRow(memory.rows.get(signal.nonce)!));

    const first = await verifyAndConsume(signal.nonce, { store: memory.store });
    expect(first.consumed).toBe(true);

    const replay = await verifyAndConsume(signal.nonce, { store: memory.store });
    expect(replay).toEqual({ consumed: false, rowCount: 0 });

    const row = memory.rows.get(signal.nonce);
    expect(row).toBeDefined();
    expect(row!.status).toBe("consumed");
    expect(row!.consumedAt).not.toBeNull();
  });

  it("denies an expired granted approval", async () => {
    const memory = createMemoryStore();
    const signal = await issueApproval(fixtureRequest(), { store: memory.store });
    memory.rows.set(
      signal.nonce,
      grantMemoryRow(memory.rows.get(signal.nonce)!, new Date(Date.now() - 1_000)),
    );

    const result = await verifyAndConsume(signal.nonce, { store: memory.store });
    expect(result).toEqual({ consumed: false, rowCount: 0 });
    expect(memory.rows.get(signal.nonce)!.status).toBe("granted");
    expect(memory.rows.get(signal.nonce)!.consumedAt).toBeNull();
  });

  it("denies a still-pending approval", async () => {
    const memory = createMemoryStore();
    const signal = await issueApproval(fixtureRequest(), { store: memory.store });

    const result = await verifyAndConsume(signal.nonce, { store: memory.store });
    expect(result).toEqual({ consumed: false, rowCount: 0 });
    expect(memory.rows.get(signal.nonce)!.status).toBe("pending");
  });
});

describe("verifyAndConsume — fail closed on invalid input", () => {
  it("rejects a non-UUID nonce before calling consume", async () => {
    let consumeCalls = 0;
    const store: ApprovalStore = {
      insert: async () => {
        throw new Error("insert must not run");
      },
      getByNonce: async () => null,
      consume: async () => {
        consumeCalls += 1;
        return { rowCount: 0, approval: null };
      },
      invalidate: async () => ({ rowCount: 0, approval: null }),
      expirePending: async () => 0,
    };

    await expect(verifyAndConsume("not-a-uuid", { store })).rejects.toThrow(/nonce/);
    await expect(verifyAndConsume("   ", { store })).rejects.toThrow(/nonce/);
    expect(consumeCalls).toBe(0);
  });
});

describe("consumeApproval — input validation (no database)", () => {
  it("rejects an empty connection string before opening a pool", async () => {
    await expect(consumeApproval({ connectionString: "   " }, randomUUID())).rejects.toThrow(
      /connectionString/,
    );
  });

  it("rejects a non-UUID nonce before opening a pool", async () => {
    await expect(
      consumeApproval({ connectionString: "postgresql://example.test/db" }, "not-a-uuid"),
    ).rejects.toThrow(/nonce/);
  });
});
