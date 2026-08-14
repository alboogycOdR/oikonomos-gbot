# @oikonomos/shared

The platform's single canonical-JSON and action-digest implementation (N10 —
no other package may reimplement this; import it instead). Node `crypto`
only, zero runtime dependencies.

```ts
import { canonicalJson, actionDigest } from "@oikonomos/shared";

canonicalJson({ b: 1, a: 2 }); // '{"a":2,"b":1}'

actionDigest({
  toolName: "mcp__gmail__create_draft",
  input: { to: "user@example.com" },
  destination: "draft",
}); // sha256 hex digest, deterministic across processes
```

## `action_digest` contract (Handover §4.3)

```
action_digest = sha256(canonicalJson({ toolName, input, destination }))
```

`toolName` and `destination` are strings; `input` is any `JsonValue`. The
digest is the lowercase hex sha256 of the canonical JSON string, UTF-8
encoded. This is the value every approval binding is checked against — a
mismatch invalidates the approval (OIK-023).

## Canonical JSON — byte-level spec

`canonicalJson(value)` serializes a `JsonValue` to a JSON string with:

- **Sorted keys.** Object keys are ordered by **UTF-16 code-unit value**
  (JavaScript's default `Array.prototype.sort()` comparator on strings),
  per RFC 8785 (JSON Canonicalization Scheme). This is deliberately **not**
  locale-aware collation and **not** UTF-8 byte ordering — those two differ
  from UTF-16 code-unit ordering for supplementary-plane characters
  (surrogate pairs), which is exactly why JCS mandates code-unit comparison:
  it is the one ordering every UTF-16-native JS engine can compute without a
  UTF-8 re-encode.
- **No insignificant whitespace.** No spaces, tabs, or newlines anywhere in
  the output; separators are a bare `,` and `:`.
- **UTF-8 output.** The canonical string is UTF-8 safe by construction: see
  "Unicode" below for how unpaired surrogates are handled.
- **Numbers in shortest round-trip form.** Numbers are serialized with
  JavaScript's native `Number` → `String` conversion (ECMA-262
  `Number::toString`), which the spec mandates to already be the shortest
  decimal string that round-trips back to the exact same IEEE-754 double.
  No additional formatting or truncation is applied.

### Edge cases (explicit decisions)

| Case | Decision |
|---|---|
| **`-0` vs `0`** | Normalized to `"0"`. JavaScript's `Number::toString` already collapses `-0` to the string `"0"` (verified: `String(-0) === "0"`), so `canonicalJson(-0) === canonicalJson(0)` holds with no special-case code. |
| **Exponent form** | Not avoided. Magnitudes `>= 1e21` or `< 1e-6` serialize in exponent form (e.g. `1e+21`, `1e-7`) because that is what ECMA-262 `Number::toString` — and therefore the shortest round-trip representation — produces for those magnitudes. Consumers that need to compare digests must not re-derive an "equivalent" numeric literal; the byte form is the contract. |
| **Unicode normalization** | **None.** Strings are serialized exactly as given, code-unit for code-unit — no NFC/NFD/NFKC/NFKD normalization is applied. `"café"` (precomposed é, one code point) and `"café"` (e + combining acute accent, two code points) are visually identical but canonicalize to **different** strings and **different** digests. Callers that need normalization-insensitive digests must normalize before calling `canonicalJson` — this package will not silently do it for them. |
| **Non-ASCII characters** | Emitted literally (unescaped), not `\uXXXX`-escaped — matching `JSON.stringify`'s and RFC 8785's behaviour. Only control characters, `"`, and `\` are escaped. |
| **Unpaired (lone) UTF-16 surrogates** | **Rejected**, with a typed `CanonicalJsonError` (`code: "LONE_SURROGATE"`). A lone surrogate (e.g. a truncated emoji) has no valid UTF-8 encoding; encoding it anyway (as Node's UTF-8 encoder does, silently substituting `U+FFFD`) would be exactly the "silent coercion" this package refuses to do, and could make two distinct malformed inputs digest identically. Valid surrogate **pairs** (real supplementary-plane characters, e.g. `𐀀` U+10000) are accepted normally. |
| **`null` vs absent key** | Distinguished. `{ "a": null }` serializes with the key present and the value `null`; `{}` (key never assigned) serializes with the key absent entirely. These produce different canonical strings and different digests — `null` is a value, absence is not. |
| **Nested arrays/objects** | Serialized recursively with the same rules at every depth; there is no depth limit. Arrays preserve element order (order is significant for arrays, unlike object keys). |
| **Non-finite numbers (`NaN`, `Infinity`, `-Infinity`)** | **Rejected**, with a typed `CanonicalJsonError` (`code: "NON_FINITE_NUMBER"`). `JSON.stringify` silently coerces all three to `null`; this package refuses that coercion and throws instead (fail-closed posture, directive §4). |
| **`undefined`** | **Rejected everywhere it can appear** — as the top-level value, as an object property value, and as an array element — with a typed `CanonicalJsonError` (`code: "UNDEFINED_VALUE"`). `JSON.stringify` silently drops `undefined` object properties and coerces `undefined` array elements to `null`; this package does neither. |
| **`bigint`, `function`, `symbol`** | **Rejected**, with a typed `CanonicalJsonError` (`code: "UNSUPPORTED_TYPE"`). None of these have a JSON representation; `JSON.stringify` either throws (`bigint`) or silently drops/nulls them (`function`, `symbol` — inconsistent depending on position), which this package will not replicate. |
| **Class instances (`Date`, `Map`, `Set`, etc.)** | **Rejected**, with a typed `CanonicalJsonError` (`code: "UNSUPPORTED_TYPE"`). Only plain objects (`Object.getPrototypeOf(value) === Object.prototype`), arrays, and JSON primitives are accepted. Callers must pre-serialize (e.g. `date.toISOString()`) before passing a value in — this package will not guess a serialization for you. |

### Typed errors

All rejections throw `CanonicalJsonError extends Error`, with a `code:
CanonicalJsonErrorCode` field (`"UNDEFINED_VALUE" | "NON_FINITE_NUMBER" |
"UNSUPPORTED_TYPE" | "LONE_SURROGATE"`) so callers can branch on the reason
programmatically instead of parsing `.message` strings.

## Testing

`packages/shared/test/` covers, per WBS OIK-017/018 acceptance:

- **Key-order stability** — the same object with keys inserted/shuffled in
  any order always canonicalizes identically (property test, 200 trials).
- **Unicode** — non-ASCII content preserved byte-for-byte, no normalization,
  lone-surrogate rejection.
- **Number forms** — integers, floats, `-0`, exponent-range magnitudes,
  `MAX_SAFE_INTEGER`.
- **Nesting** — arrays of objects of arrays, `null` vs absent, empty
  array/object.
- **No collisions** — a fixture set of structurally distinct values (no
  credential-like content, per N4) all produce distinct canonical strings
  and distinct digests.
- **Cross-process reproducibility** — `actionDigest` computed by a freshly
  spawned `node` child process (running the actual shipped source,
  transpiled at test time) matches the in-process result.

Run: `pnpm --filter @oikonomos/shared test`.
