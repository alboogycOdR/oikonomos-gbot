import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "../src/canonicalJson.js";
import { actionDigest } from "../src/actionDigest.js";

/**
 * Digest fixture pin (TASK-074).
 *
 * `canonicalJson.test.ts` / `reproducibility.test.ts` prove key-order
 * *insensitivity* (many inputs -> the same output) but pin no literal
 * byte string anywhere, so a canonicalization regression that still
 * produces *some* stable, self-consistent output would pass every existing
 * test and silently re-baseline on the next run. These fixtures are
 * one-time-computed, committed literal values: a regression must now
 * produce output that differs from a constant written down in this file,
 * not from "whatever the code currently does".
 *
 * Per TASK-074 scope: canonicalJson.ts and actionDigest.ts are NOT
 * modified by this task. If a pin below had exposed a discrepancy against
 * the README spec, that would be a SPEC_AMBIGUITY block, not a fix here —
 * it did not; every value below matches the README's documented behaviour.
 */

// README edge cases: "-0 vs 0", unicode (precomposed vs decomposed,
// non-ASCII literal emission), nested arrays/objects, null-vs-absent key.
const FIXTURES = {
  negativeZero: { value: -0 } satisfies JsonValue,
  unicodePrecomposed: { greeting: "café" } satisfies JsonValue, // "é" = one code point (U+00E9)
  unicodeDecomposed: { greeting: "café" } satisfies JsonValue, // "e" + combining acute (U+0301)
  nested: {
    a: [1, { b: 2, c: [null, "x", -0] }],
    z: { deep: [[1, 2], { k: "v" }] },
  } satisfies JsonValue,
  nullValue: { a: null } satisfies JsonValue,
  absentKey: {} satisfies JsonValue,
  // Keys deliberately out of sorted order in source — canonicalJson must
  // still sort them; used by the mutation-proof test below.
  unsortedKeys: { zebra: 1, apple: 2, mango: { yak: 1, banana: 2 } } satisfies JsonValue,
} as const;

describe("digest pin — canonicalJson byte output (regression cannot silently re-baseline)", () => {
  it("pins the -0-vs-0 fixture", () => {
    expect(canonicalJson(FIXTURES.negativeZero)).toBe('{"value":0}');
  });

  it("pins the precomposed-unicode fixture", () => {
    expect(canonicalJson(FIXTURES.unicodePrecomposed)).toBe('{"greeting":"café"}');
  });

  it("pins the decomposed-unicode fixture (different bytes than precomposed — no normalization)", () => {
    expect(canonicalJson(FIXTURES.unicodeDecomposed)).toBe('{"greeting":"café"}');
    expect(canonicalJson(FIXTURES.unicodeDecomposed)).not.toBe(canonicalJson(FIXTURES.unicodePrecomposed));
  });

  it("pins the nested-structure fixture", () => {
    expect(canonicalJson(FIXTURES.nested)).toBe('{"a":[1,{"b":2,"c":[null,"x",0]}],"z":{"deep":[[1,2],{"k":"v"}]}}');
  });

  it("pins null-present vs key-absent as distinct byte strings", () => {
    expect(canonicalJson(FIXTURES.nullValue)).toBe('{"a":null}');
    expect(canonicalJson(FIXTURES.absentKey)).toBe("{}");
    expect(canonicalJson(FIXTURES.nullValue)).not.toBe(canonicalJson(FIXTURES.absentKey));
  });

  it("pins the unsorted-source-key fixture to its sorted-key output", () => {
    expect(canonicalJson(FIXTURES.unsortedKeys)).toBe('{"apple":2,"mango":{"banana":2,"yak":1},"zebra":1}');
  });
});

describe("digest pin — actionDigest literal hex (regression cannot silently re-baseline)", () => {
  it("pins the sha256 hex digest for each README-edge-case fixture as an action input", () => {
    expect(
      actionDigest({ toolName: "pin.tool", input: FIXTURES.negativeZero, destination: "pin.dest" }),
    ).toBe("426869d2e36fb70284685dc09e3890331b8de51ccba3362292175987b6209aec");

    expect(
      actionDigest({ toolName: "pin.tool", input: FIXTURES.unicodePrecomposed, destination: "pin.dest" }),
    ).toBe("2498583abebce57e3c647325a63ef4dd9ea48d242462c7e2ec504074dbca67cf");

    expect(
      actionDigest({ toolName: "pin.tool", input: FIXTURES.unicodeDecomposed, destination: "pin.dest" }),
    ).toBe("32e7f3cfdea86744a2872c395c503d3d3da84a877d7aebcff3fe7ff4189b1fe5");

    expect(
      actionDigest({ toolName: "pin.tool", input: FIXTURES.nested, destination: "pin.dest" }),
    ).toBe("4578c05b6ef7a9771fed1986f245a4f0a0eb02cf21de99acc4125311ad891480");

    expect(
      actionDigest({ toolName: "pin.tool", input: FIXTURES.nullValue, destination: "pin.dest" }),
    ).toBe("045037e8c534de6ac4624f265b85687b67eaf3164c6c59e6b167206e7a5cb1f5");

    expect(
      actionDigest({ toolName: "pin.tool", input: FIXTURES.absentKey, destination: "pin.dest" }),
    ).toBe("0054c0f3158b5f4f5b8aa0ea2ca7e2923000384a756e59e24ada770bfe6231db");
  });
});

describe("digest pin — mutation-proof (a sort-order regression must fail the pin)", () => {
  /**
   * Deliberately re-implements canonicalization WITHOUT key sorting — a
   * stand-in for the exact regression class this pin exists to catch
   * (e.g. someone "optimizes away" the `.sort()` call in
   * `serializeObject`). Test-local only; canonicalJson.ts is untouched.
   */
  function naiveNoSortJson(value: JsonValue): string {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map((v) => naiveNoSortJson(v)).join(",") + "]";
    }
    const record = value as Record<string, JsonValue>;
    const keys = Object.keys(record); // insertion order — NOT sorted
    return "{" + keys.map((k) => `${JSON.stringify(k)}:${naiveNoSortJson(record[k] as JsonValue)}`).join(",") + "}";
  }

  it("a sort-omitting reimplementation diverges from the committed canonicalJson pin", () => {
    const pinned = canonicalJson(FIXTURES.unsortedKeys);
    const naive = naiveNoSortJson(FIXTURES.unsortedKeys);
    expect(naive).not.toBe(pinned);
    // The pin itself is exactly the sorted form, proving it is sort-order-dependent.
    expect(pinned).toBe('{"apple":2,"mango":{"banana":2,"yak":1},"zebra":1}');
  });

  it("a sort-omitting reimplementation's digest diverges from the committed actionDigest pin", () => {
    const regressedCanonical = naiveNoSortJson(FIXTURES.unsortedKeys);
    const regressedDigest = createHash("sha256").update(regressedCanonical, "utf8").digest("hex");
    const pinnedDigest = actionDigest({ toolName: "pin.tool", input: FIXTURES.unsortedKeys, destination: "pin.dest" });
    expect(regressedDigest).not.toBe(pinnedDigest);
  });
});
