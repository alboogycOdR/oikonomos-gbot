/**
 * Canonical JSON — the platform's single implementation (N10).
 *
 * See packages/shared/README.md for the byte-level spec. Summary: sorted
 * keys (UTF-16 code-unit order, per RFC 8785 JCS), no insignificant
 * whitespace, UTF-8 output, numbers in ECMA-262 shortest round-trip form.
 * Fail-closed: non-finite numbers, `undefined`, lone surrogates, bigints,
 * functions, symbols, and non-plain objects all throw a typed
 * {@link CanonicalJsonError} instead of being silently coerced or dropped.
 */

/** Discriminates why a value could not be canonicalized. */
export type CanonicalJsonErrorCode =
  | "UNDEFINED_VALUE"
  | "NON_FINITE_NUMBER"
  | "UNSUPPORTED_TYPE"
  | "LONE_SURROGATE";

/** Typed error raised whenever a value cannot be represented in canonical JSON. */
export class CanonicalJsonError extends Error {
  readonly code: CanonicalJsonErrorCode;

  constructor(code: CanonicalJsonErrorCode, message: string) {
    super(message);
    this.name = "CanonicalJsonError";
    this.code = code;
  }
}

/** A JSON-representable value — the only shapes canonicalJson() accepts. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Serialize `value` to its canonical JSON string form: object keys sorted
 * by UTF-16 code unit, no whitespace, numbers in shortest round-trip form.
 * Throws {@link CanonicalJsonError} for any value that cannot be
 * canonicalized instead of silently coercing or dropping it.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    throw new CanonicalJsonError(
      "UNDEFINED_VALUE",
      "undefined is not permitted in canonical JSON",
    );
  }

  const type = typeof value;

  if (type === "boolean") {
    return value ? "true" : "false";
  }
  if (type === "number") {
    return serializeNumber(value as number);
  }
  if (type === "string") {
    return serializeString(value as string);
  }
  if (type === "bigint") {
    throw new CanonicalJsonError(
      "UNSUPPORTED_TYPE",
      "bigint is not permitted in canonical JSON",
    );
  }
  if (type === "function" || type === "symbol") {
    throw new CanonicalJsonError(
      "UNSUPPORTED_TYPE",
      `${type} is not permitted in canonical JSON`,
    );
  }

  // type === "object" from here
  if (Array.isArray(value)) {
    return serializeArray(value);
  }
  return serializeObject(value as object);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalJsonError(
      "NON_FINITE_NUMBER",
      `non-finite number (${String(n)}) is not permitted in canonical JSON`,
    );
  }
  // ECMA-262 Number::toString is already the shortest round-trip decimal
  // representation, and JS collapses -0 to the string "0" here, so no
  // additional normalization is required — see README "-0 vs 0".
  return String(n);
}

function serializeString(s: string): string {
  if (LONE_SURROGATE.test(s)) {
    throw new CanonicalJsonError(
      "LONE_SURROGATE",
      "string contains an unpaired UTF-16 surrogate, which has no valid UTF-8 encoding",
    );
  }
  // JSON.stringify on a string only escapes control characters, the
  // backslash, and the double quote — every other code point (including
  // non-ASCII) is emitted literally, unnormalized. See README "unicode".
  return JSON.stringify(s);
}

function serializeArray(arr: unknown[]): string {
  const parts = arr.map((element) => serialize(element));
  return "[" + parts.join(",") + "]";
}

function serializeObject(obj: object): string {
  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError(
      "UNSUPPORTED_TYPE",
      "only plain objects, arrays, and primitives are permitted in canonical JSON",
    );
  }

  const record = obj as Record<string, unknown>;
  // Sort by UTF-16 code unit — the default JS string comparator — per
  // RFC 8785 JCS, deliberately not UTF-8 byte order or locale collation.
  // See README "key ordering".
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${serializeString(key)}:${serialize(record[key])}`);
  return "{" + parts.join(",") + "}";
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("canonicalJson (in-source smoke test; full suite in test/)", () => {
    it("sorts keys and strips whitespace", () => {
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });
    it("rejects undefined", () => {
      expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    });
  });
}
