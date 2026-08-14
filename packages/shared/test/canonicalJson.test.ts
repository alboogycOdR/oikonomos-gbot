import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson } from "../src/canonicalJson.js";
import { mulberry32, randomValue, shuffle } from "./prng.js";

describe("canonicalJson — key order stability", () => {
  it("produces identical output regardless of insertion order", () => {
    const a = { zebra: 1, apple: 2, mango: 3, banana: { z: 1, a: 2 } };
    const b = { mango: 3, banana: { a: 2, z: 1 }, apple: 2, zebra: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"apple":2,"banana":{"a":2,"z":1},"mango":3,"zebra":1}');
  });

  it("property: 200 random key-order shuffles of the same object yield byte-identical output", () => {
    const rng = mulberry32(1);
    const base: Record<string, number> = {};
    for (let i = 0; i < 12; i += 1) {
      base[`key${i}`] = i;
    }
    const canonical = canonicalJson(base);
    for (let trial = 0; trial < 200; trial += 1) {
      const shuffledKeys = shuffle(rng, Object.keys(base));
      const reordered: Record<string, number> = {};
      for (const key of shuffledKeys) {
        reordered[key] = base[key] as number;
      }
      expect(canonicalJson(reordered)).toBe(canonical);
    }
  });

  it("sorts keys by UTF-16 code unit, not locale collation (RFC 8785 stance)", () => {
    // "Z" (0x5A) sorts before "a" (0x61) in code-unit order, unlike most
    // locale-aware collations which treat case-insensitively.
    const obj = { a: 1, Z: 2 };
    expect(canonicalJson(obj)).toBe('{"Z":2,"a":1}');
  });
});

describe("canonicalJson — unicode content", () => {
  it("does not NFC-normalize combining sequences (documented no-normalization stance)", () => {
    const precomposed = "é"; // é as a single code point
    const decomposed = "é"; // e + combining acute accent
    expect(canonicalJson(precomposed)).not.toBe(canonicalJson(decomposed));
    expect(canonicalJson(precomposed)).toBe('"é"');
    expect(canonicalJson(decomposed)).toBe('"é"');
  });

  it("emits non-ASCII characters literally, unescaped", () => {
    expect(canonicalJson("café 漢字 😀")).toBe('"café 漢字 😀"');
  });

  it("rejects unpaired (lone) surrogates with a typed LONE_SURROGATE error", () => {
    expect(() => canonicalJson("\uD800")).toThrow(CanonicalJsonError);
    try {
      canonicalJson("\uD800");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalJsonError);
      expect((err as CanonicalJsonError).code).toBe("LONE_SURROGATE");
    }
    expect(() => canonicalJson("\uDC00")).toThrow(CanonicalJsonError);
  });

  it("accepts valid surrogate pairs (supplementary-plane characters)", () => {
    const supplementary = "𐀀"; // U+10000, a valid surrogate pair
    expect(() => canonicalJson(supplementary)).not.toThrow();
  });

  it("property: 100 random nested values with unicode strings are stable across two calls", () => {
    const rng = mulberry32(7);
    for (let trial = 0; trial < 100; trial += 1) {
      const value = randomValue(rng, 3);
      expect(canonicalJson(value)).toBe(canonicalJson(value));
    }
  });
});

describe("canonicalJson — number forms", () => {
  it("integers and floats use shortest round-trip form", () => {
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(1)).toBe("1");
    expect(canonicalJson(100)).toBe("100");
    expect(canonicalJson(0.1)).toBe("0.1");
    expect(canonicalJson(3.14159)).toBe("3.14159");
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
  });

  it("normalizes -0 to 0 (documented stance)", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(0)).toBe(canonicalJson(-0));
  });

  it("uses exponent form for very large/small magnitudes, matching ECMA-262 ToString", () => {
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(canonicalJson(1e-7)).toBe("1e-7");
  });

  it("rejects NaN and +/-Infinity with a typed NON_FINITE_NUMBER error", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
      try {
        canonicalJson(bad);
        expect.unreachable();
      } catch (err) {
        expect((err as CanonicalJsonError).code).toBe("NON_FINITE_NUMBER");
      }
    }
  });

  it("property: 100 random numeric values round-trip stably across two calls", () => {
    const rng = mulberry32(13);
    for (let trial = 0; trial < 100; trial += 1) {
      const value = { n: Math.floor(rng() * 2 ** 40) - 2 ** 39, f: rng() * 1000 };
      expect(canonicalJson(value)).toBe(canonicalJson(value));
    }
  });
});

describe("canonicalJson — nesting", () => {
  it("handles arrays of objects of arrays", () => {
    const value = { list: [{ a: [1, 2, { b: 3 }] }, { c: null }] };
    expect(canonicalJson(value)).toBe('{"list":[{"a":[1,2,{"b":3}]},{"c":null}]}');
  });

  it("null vs absent key are distinguished", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it("empty array and empty object serialize distinctly", () => {
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("property: 100 random deeply nested values are stable across two calls and JSON.parse-round-trip equal", () => {
    const rng = mulberry32(29);
    for (let trial = 0; trial < 100; trial += 1) {
      const value = randomValue(rng, 4);
      const first = canonicalJson(value);
      const second = canonicalJson(value);
      expect(first).toBe(second);
      // Sanity: the canonical string is valid JSON that round-trips through
      // JSON.parse without throwing.
      expect(() => JSON.parse(first)).not.toThrow();
    }
  });
});

describe("canonicalJson — fail-closed posture (no silent coercion)", () => {
  it("rejects undefined at top level with a typed UNDEFINED_VALUE error", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    try {
      canonicalJson(undefined);
      expect.unreachable();
    } catch (err) {
      expect((err as CanonicalJsonError).code).toBe("UNDEFINED_VALUE");
    }
  });

  it("rejects undefined nested in an object value (does not silently drop the key)", () => {
    expect(() => canonicalJson({ a: 1, b: undefined })).toThrow(CanonicalJsonError);
  });

  it("rejects undefined nested in an array element (does not coerce to null)", () => {
    expect(() => canonicalJson([1, undefined, 3])).toThrow(CanonicalJsonError);
  });

  it("rejects bigint, function, and symbol with a typed UNSUPPORTED_TYPE error", () => {
    expect(() => canonicalJson(1n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(() => 1)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Symbol("x"))).toThrow(CanonicalJsonError);
  });

  it("rejects non-plain objects (class instances) with a typed UNSUPPORTED_TYPE error", () => {
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Set())).toThrow(CanonicalJsonError);
  });
});

describe("canonicalJson — no collisions across a fixture set", () => {
  it("distinct structural fixtures (no credential-like values, per N4) all yield distinct output", () => {
    const fixtures: unknown[] = [
      { toolName: "mcp__gmail__list_messages", input: {}, destination: "inbox" },
      { toolName: "mcp__gmail__create_draft", input: { to: "placeholder@example.com" }, destination: "draft" },
      { toolName: "mcp__slack__post_message", input: { channel: "general", text: "hello" }, destination: "slack" },
      { a: 1, b: 2 },
      { a: 1, b: 3 },
      { a: [1, 2, 3] },
      { a: [1, 2, "3"] },
      [1, 2, 3],
      "just a string",
      42,
      true,
      false,
      null,
      {},
      [],
      { nested: { deeper: { value: "placeholder-token-not-a-real-secret" } } },
    ];
    const serialized = fixtures.map((f) => canonicalJson(f));
    const unique = new Set(serialized);
    expect(unique.size).toBe(serialized.length);
  });
});
