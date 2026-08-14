import { describe, expect, it } from "vitest";
import { actionDigest } from "../src/actionDigest.js";
import { CanonicalJsonError } from "../src/canonicalJson.js";
import { mulberry32, randomValue } from "./prng.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe("actionDigest — basic contract", () => {
  it("returns a 64-char lowercase hex sha256 digest", () => {
    const digest = actionDigest({
      toolName: "mcp__gmail__list_messages",
      input: {},
      destination: "inbox",
    });
    expect(digest).toMatch(SHA256_HEX);
  });

  it("is deterministic: the same value always yields the same digest", () => {
    const action = {
      toolName: "mcp__slack__post_message",
      input: { channel: "general", text: "placeholder message" },
      destination: "slack://general",
    };
    expect(actionDigest(action)).toBe(actionDigest(action));
  });

  it("is independent of the order fields were assigned in the input object", () => {
    const a = actionDigest({
      toolName: "t",
      input: { z: 1, a: 2 },
      destination: "d",
    });
    const b = actionDigest({
      toolName: "t",
      input: { a: 2, z: 1 },
      destination: "d",
    });
    expect(a).toBe(b);
  });

  it("changes when any bound field changes", () => {
    const base = { toolName: "t", input: { x: 1 }, destination: "d" };
    const changedTool = { ...base, toolName: "t2" };
    const changedInput = { ...base, input: { x: 2 } };
    const changedDest = { ...base, destination: "d2" };
    const baseDigest = actionDigest(base);
    expect(actionDigest(changedTool)).not.toBe(baseDigest);
    expect(actionDigest(changedInput)).not.toBe(baseDigest);
    expect(actionDigest(changedDest)).not.toBe(baseDigest);
  });
});

describe("actionDigest — fail-closed posture", () => {
  it("propagates CanonicalJsonError for undefined nested in input", () => {
    expect(() =>
      actionDigest({
        toolName: "t",
        // @ts-expect-error — deliberately invalid at the type level too
        input: { x: undefined },
        destination: "d",
      }),
    ).toThrow(CanonicalJsonError);
  });

  it("propagates CanonicalJsonError for a non-finite number nested in input", () => {
    expect(() =>
      actionDigest({
        toolName: "t",
        input: { x: NaN },
        destination: "d",
      }),
    ).toThrow(CanonicalJsonError);
  });
});

describe("actionDigest — no collisions across a fixture set (N4: no credential-like values)", () => {
  it("distinct action fixtures each yield a distinct digest", () => {
    const fixtures = [
      { toolName: "mcp__gmail__list_messages", input: {}, destination: "inbox" },
      { toolName: "mcp__gmail__create_draft", input: { to: "placeholder@example.com" }, destination: "draft" },
      { toolName: "mcp__gmail__create_draft", input: { to: "placeholder2@example.com" }, destination: "draft" },
      { toolName: "mcp__slack__post_message", input: { channel: "general", text: "hi" }, destination: "slack" },
      { toolName: "mcp__slack__post_message", input: { channel: "random", text: "hi" }, destination: "slack" },
      { toolName: "t", input: [1, 2, 3], destination: "d" },
      { toolName: "t", input: [1, 2, "3"], destination: "d" },
      { toolName: "t", input: null, destination: "d" },
      { toolName: "t", input: {}, destination: "d" },
    ] as const;
    const digests = fixtures.map((f) => actionDigest(f));
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("property: 150 random structurally-distinct actions collide only when structurally equal", () => {
    const rng = mulberry32(101);
    const seen = new Map<string, unknown>();
    for (let trial = 0; trial < 150; trial += 1) {
      const action = {
        toolName: `tool_${trial % 5}`,
        input: randomValue(rng, 3),
        destination: `dest_${trial % 7}`,
      };
      const digest = actionDigest(action);
      const canonicalKey = JSON.stringify(action);
      const prior = seen.get(digest);
      if (prior !== undefined) {
        // A digest repeat is only acceptable if the canonical action was
        // itself identical (JSON.stringify is order-sensitive so this is a
        // conservative, not exact, structural-equality check).
        expect(JSON.stringify(prior)).toBe(canonicalKey);
      }
      seen.set(digest, action);
    }
  });
});
