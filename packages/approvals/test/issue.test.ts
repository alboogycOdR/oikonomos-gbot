import { actionDigest, CanonicalJsonError } from "@oikonomos/shared";
import { describe, expect, it } from "vitest";

import { bindActionDigest } from "../src/bind.js";
import {
  DEFAULT_APPROVAL_TTL_MS,
  issueApproval,
  type ApprovalWaitSignal,
} from "../src/issue.js";
import type { ApprovalStore } from "../src/store.js";
import { createMemoryStore, expectedRender, fixtureRequest } from "./helpers.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("issueApproval — binding + row contents", () => {
  it("returns a wait signal whose row carries digest, render, destination, nonce, and expiry", async () => {
    const memory = createMemoryStore();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const request = fixtureRequest({ expiresAt });

    const signal = await issueApproval(request, { store: memory.store });

    expect(signal.reason).toBe("approval_pending");
    expect(signal.status).toBe("pending");
    expect(signal.approvalId).toMatch(UUID_RE);
    expect(signal.nonce).toMatch(UUID_RE);
    expect(signal.actionRender).toBe(expectedRender(request));
    expect(signal.destination).toBe(request.destination);
    expect(signal.expiresAt).toEqual(expiresAt);
    expect(signal.actionDigest).toMatch(SHA256_HEX);

    const row = await memory.store.getByNonce(signal.nonce);
    expect(row).not.toBeNull();
    expect(row!.actionRender).toBe(expectedRender(request));
    expect(row!.destination).toBe(request.destination);
    expect(row!.nonce).toBe(signal.nonce);
    expect(row!.expiresAt).toEqual(expiresAt);
    expect(row!.actionDigest.equals(Buffer.from(signal.actionDigest, "hex"))).toBe(true);
  });

  it("produces action_digest via @oikonomos/shared, matching bindActionDigest", async () => {
    const memory = createMemoryStore();
    const request = fixtureRequest({
      input: { z: 1, a: 2 },
    });

    const expected = actionDigest({
      toolName: request.toolName,
      input: request.input,
      destination: request.destination,
    });
    expect(bindActionDigest({
      toolName: request.toolName,
      input: { a: 2, z: 1 },
      destination: request.destination,
    })).toBe(expected);

    const signal = await issueApproval(request, { store: memory.store });
    expect(signal.actionDigest).toBe(expected);

    const row = memory.rows.get(signal.nonce);
    expect(row).toBeDefined();
    expect(row!.actionDigest.equals(Buffer.from(expected, "hex"))).toBe(true);
  });

  it("defaults expiry to now + 4 hours when expiresAt is omitted", async () => {
    const memory = createMemoryStore();
    const before = Date.now();
    const signal = await issueApproval(fixtureRequest(), { store: memory.store });
    const after = Date.now();

    expect(signal.expiresAt.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_APPROVAL_TTL_MS);
    expect(signal.expiresAt.getTime()).toBeLessThanOrEqual(after + DEFAULT_APPROVAL_TTL_MS);
  });
});

describe("issueApproval — persist before wait", () => {
  it("does not resolve the wait signal until persist completes", async () => {
    let release!: (row: Awaited<ReturnType<ApprovalStore["insert"]>>) => void;
    const gate = new Promise<Awaited<ReturnType<ApprovalStore["insert"]>>>((resolve) => {
      release = resolve;
    });
    let issueSettled = false;

    const backing = createMemoryStore();
    const store: ApprovalStore = {
      insert: async (approval) => {
        const row = await backing.store.insert(approval);
        return gate.then(() => row);
      },
      getByNonce: (nonce) => backing.store.getByNonce(nonce),
      consume: (nonce) => backing.store.consume(nonce),
      invalidate: (nonce) => backing.store.invalidate(nonce),
      expirePending: () => backing.store.expirePending(),
    };

    const pending = issueApproval(fixtureRequest(), { store }).then((signal) => {
      issueSettled = true;
      return signal;
    });

    const deadline = Date.now() + 1000;
    while (backing.rows.size === 0) {
      if (Date.now() > deadline) {
        throw new Error("persist did not run before wait signal");
      }
      await Promise.resolve();
    }
    expect(issueSettled).toBe(false);

    const staged = [...backing.rows.values()][0];
    expect(staged).toBeDefined();
    release(staged!);

    const signal = await pending;
    expect(issueSettled).toBe(true);
    expect(await store.getByNonce(signal.nonce)).not.toBeNull();
  });

  it("asserts the row exists at the moment the wait signal is returned", async () => {
    const memory = createMemoryStore();
    const signal = await issueApproval(fixtureRequest(), { store: memory.store });

    expect(memory.events).toEqual(["persist"]);
    const rowAtReturn = await memory.store.getByNonce(signal.nonce);
    expect(rowAtReturn).not.toBeNull();
    expect(rowAtReturn!.approvalId).toBe(signal.approvalId);
    expect(rowAtReturn!.nonce).toBe(signal.nonce);
  });

  it("does not return a wait signal when persist rejects", async () => {
    const store: ApprovalStore = {
      insert: async () => {
        throw new Error("write failed");
      },
      getByNonce: async () => null,
      consume: async () => ({ rowCount: 0, approval: null }),
      invalidate: async () => ({ rowCount: 0, approval: null }),
      expirePending: async () => 0,
    };

    await expect(issueApproval(fixtureRequest(), { store })).rejects.toThrow("write failed");
  });
});

describe("issueApproval — fail closed on invalid input", () => {
  it("rejects empty required fields before persist", async () => {
    const memory = createMemoryStore();
    const deps = { store: memory.store };

    await expect(issueApproval(fixtureRequest({ toolName: "  " }), deps)).rejects.toThrow(
      /toolName/,
    );
    await expect(issueApproval(fixtureRequest({ destination: "" }), deps)).rejects.toThrow(
      /destination/,
    );
    await expect(issueApproval(fixtureRequest({ capabilityId: "" }), deps)).rejects.toThrow(
      /capabilityId/,
    );
    await expect(issueApproval(fixtureRequest({ runId: "not-a-uuid" }), deps)).rejects.toThrow(
      /runId/,
    );
    expect(memory.events).toEqual([]);
  });

  it("propagates CanonicalJsonError and does not persist", async () => {
    const memory = createMemoryStore();
    await expect(
      issueApproval(
        fixtureRequest({
          // @ts-expect-error — deliberately invalid
          input: { x: undefined },
        }),
        { store: memory.store },
      ),
    ).rejects.toThrow(CanonicalJsonError);
    expect(memory.events).toEqual([]);
  });
});

describe("issueApproval — concurrent nonce uniqueness", () => {
  it("issues unique CSPRNG nonces under concurrent issuance", async () => {
    const memory = createMemoryStore();
    const signals: ApprovalWaitSignal[] = await Promise.all(
      Array.from({ length: 50 }, () => issueApproval(fixtureRequest(), { store: memory.store })),
    );
    const nonces = signals.map((signal) => signal.nonce);
    expect(new Set(nonces).size).toBe(50);
    expect(memory.rows.size).toBe(50);
  });
});
