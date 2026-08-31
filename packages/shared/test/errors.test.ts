import { describe, expect, it } from "vitest";
import {
  GENERIC_ERROR_CODE,
  RegisteredError,
  defineRegisteredError,
  emitErrorTags,
  lookupErrorDefinition,
  SAFE_VALUE,
} from "../src/errors/registry.js";
import {
  mintAuditWriteError,
  mintBrokerFailure,
  mintL2ConfigError,
} from "../src/errors/seeds.js";

describe("error registry — unregistered errors", () => {
  it("a plain Error maps to the generic code with payload dropped entirely", () => {
    const tags = emitErrorTags(new Error("boom: unsafe credential-shaped text present"));
    expect(tags.code).toBe(GENERIC_ERROR_CODE);
    expect(tags.payload).toEqual({});
    expect(Object.isFrozen(tags.payload)).toBe(true);
  });

  it("a non-Error thrown value also maps to the generic code", () => {
    expect(emitErrorTags("just a string").code).toBe(GENERIC_ERROR_CODE);
    expect(emitErrorTags(undefined).code).toBe(GENERIC_ERROR_CODE);
    expect(emitErrorTags({ code: "BROKER_FAILURE" }).code).toBe(GENERIC_ERROR_CODE);
  });

  it("GENERIC_ERROR_CODE cannot be reused as a registry code", () => {
    expect(() =>
      defineRegisteredError({
        code: GENERIC_ERROR_CODE,
        domain: "x",
        retryable: false,
        summary: "should never register",
        payload: [] as const,
      }),
    ).toThrow(/reserved/);
  });
});

describe("error registry — registered errors emit only declared, safe fields", () => {
  const mintTestError = defineRegisteredError({
    code: "TEST_ERR_ALLOWLIST",
    domain: "test",
    retryable: true,
    summary: "test error for allowlist behavior",
    payload: ["reason", "target"] as const,
  });

  it("emits only declared fields with safe-charset string values", () => {
    const err = mintTestError({ reason: "timeout", target: "svc-1", extra: "not-declared" });
    const tags = emitErrorTags(err);
    expect(tags.code).toBe("TEST_ERR_ALLOWLIST");
    expect(tags.domain).toBe("test");
    expect(tags.retryable).toBe(true);
    expect(tags.payload).toEqual({ reason: "timeout", target: "svc-1" });
    expect((tags.payload as Record<string, unknown>).extra).toBeUndefined();
  });

  it("drops undeclared fields even if present in the raw payload passed to the constructor", () => {
    // rawPayload is frozen at construction, so the only way an undeclared
    // field can reach it is via the constructor call itself — confirming
    // even that path never survives the emit boundary.
    const undeclaredValue = ["undisclosed", "value", "here"].join("-");
    const err = mintTestError({ reason: "ok", target: "t", undeclaredField: undeclaredValue } as Record<
      string,
      unknown
    >);
    expect((err.rawPayload as Record<string, unknown>).undeclaredField).toBe(undeclaredValue);
    const tags = emitErrorTags(err);
    expect((tags.payload as Record<string, unknown>).undeclaredField).toBeUndefined();
  });

  it("drops out-of-charset string values instead of truncating them", () => {
    const err = mintTestError({ reason: "has spaces and $ymbols!", target: "ok-value" });
    const tags = emitErrorTags(err);
    expect(tags.payload.reason).toBeUndefined();
    expect(tags.payload.target).toBe("ok-value");
  });

  it("drops oversized string values (>64 chars) instead of truncating them", () => {
    const longValue = "a".repeat(65);
    const shortValue = "a".repeat(64);
    expect(SAFE_VALUE.test(longValue)).toBe(false);
    expect(SAFE_VALUE.test(shortValue)).toBe(true);

    const err = mintTestError({ reason: longValue, target: shortValue });
    const tags = emitErrorTags(err);
    expect(tags.payload.reason).toBeUndefined();
    expect(tags.payload.target).toBe(shortValue);
  });

  it("drops non-string values (numbers, objects, null) for declared fields", () => {
    const err = mintTestError({ reason: 123 as unknown as string, target: { nested: true } as unknown as string });
    const tags = emitErrorTags(err);
    expect(tags.payload).toEqual({});
  });

  it("retryable is read straight from the definition, not re-derived per catch site", () => {
    const retryableCtor = defineRegisteredError({
      code: "TEST_ERR_RETRYABLE",
      domain: "test",
      retryable: true,
      summary: "retryable",
      payload: [] as const,
    });
    const nonRetryableCtor = defineRegisteredError({
      code: "TEST_ERR_NON_RETRYABLE",
      domain: "test",
      retryable: false,
      summary: "non-retryable",
      payload: [] as const,
    });
    expect(emitErrorTags(retryableCtor({})).retryable).toBe(true);
    expect(emitErrorTags(nonRetryableCtor({})).retryable).toBe(false);
  });
});

describe("error registry — closed taxonomy invariants", () => {
  it("duplicate code registration throws at definition time", () => {
    defineRegisteredError({
      code: "TEST_ERR_DUP_ONCE",
      domain: "test",
      retryable: false,
      summary: "first",
      payload: [] as const,
    });
    expect(() =>
      defineRegisteredError({
        code: "TEST_ERR_DUP_ONCE",
        domain: "test",
        retryable: false,
        summary: "second, should throw",
        payload: [] as const,
      }),
    ).toThrow(/duplicate code/);
  });

  it("duplicate payload field names on one definition throw", () => {
    expect(() =>
      defineRegisteredError({
        code: "TEST_ERR_DUP_FIELD",
        domain: "test",
        retryable: false,
        summary: "dup field",
        payload: ["reason", "reason"] as const,
      }),
    ).toThrow(/duplicate payload field/);
  });

  it("lookupErrorDefinition returns the frozen definition for a registered code, undefined otherwise", () => {
    const def = lookupErrorDefinition("BROKER_FAILURE");
    expect(def?.domain).toBe("broker");
    expect(Object.isFrozen(def)).toBe(true);
    expect(lookupErrorDefinition("NOT_A_REAL_CODE")).toBeUndefined();
  });

  it("a RegisteredError instance is only trusted if its code is still registered", () => {
    // A hand-forged RegisteredError-shaped object (not minted through a
    // constructor from defineRegisteredError) using a code never
    // registered must still collapse to the generic tags.
    class Impersonator extends RegisteredError {}
    const fake = new Impersonator(
      { code: "NEVER_REGISTERED", domain: "x", retryable: true, summary: "s", payload: ["p"] },
      { p: "value-that-looks-safe" },
    );
    expect(emitErrorTags(fake).code).toBe(GENERIC_ERROR_CODE);
    expect(emitErrorTags(fake).payload).toEqual({});
  });
});

describe("error registry — N4: a credential-shaped string in an undeclared field never reaches the emitted tags", () => {
  it("BrokerFailure-style error carrying an undeclared credential field never leaks it", () => {
    const placeholderCredential = ["YOUR_KEY_HERE", "abcdef1234567890"].join("-");
    const err = mintBrokerFailure(
      {
        reason: "unauthorized",
        toolName: "mcp__gmail__send",
        // Not declared on BROKER_FAILURE's payload allowlist.
        undeclaredCredentialField: placeholderCredential,
        undeclaredHeaderField: `Bearer ${placeholderCredential}`,
      } as Record<string, unknown>,
    );
    const tags = emitErrorTags(err);
    expect(tags.payload).toEqual({ reason: "unauthorized", toolName: "mcp__gmail__send" });
    const serialized = JSON.stringify(tags);
    expect(serialized).not.toContain(placeholderCredential);
  });

  it("AuditWriteError-style error never lets a credential-shaped value onto a DECLARED field either, if out of charset", () => {
    // Credentials commonly contain characters outside the safe charset
    // (spaces, '=', '/', etc. in tokens/headers) even when stuffed into a
    // declared field name by mistake.
    const bearerLikeValue = "Authorization: Bearer YOUR_KEY_HERE/1234+567==";
    const err = mintAuditWriteError({
      actor: "connector:gmail",
      eventType: bearerLikeValue,
    });
    const tags = emitErrorTags(err);
    expect(tags.payload.actor).toBe("connector:gmail");
    expect(tags.payload.eventType).toBeUndefined();
  });

  it("L2ConfigError-style constructor is typed to the seed's own declared payload fields", () => {
    const err = mintL2ConfigError({ l2Code: "BARE_NAME", entry: "mcp__gmail__send_message" });
    const tags = emitErrorTags(err);
    expect(tags.code).toBe("L2_CONFIG_INVALID");
    expect(tags.payload).toEqual({ l2Code: "BARE_NAME", entry: "mcp__gmail__send_message" });
  });
});

describe("error registry — zero runtime dependencies", () => {
  it("the registry module imports nothing but itself (no bare-specifier imports)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const registrySrc = await fs.readFile(path.join(here, "../src/errors/registry.ts"), "utf8");
    const seedsSrc = await fs.readFile(path.join(here, "../src/errors/seeds.ts"), "utf8");
    const importLines = [...registrySrc.matchAll(/^import .*$/gm), ...seedsSrc.matchAll(/^import .*$/gm)].map(
      (m) => m[0],
    );
    for (const line of importLines) {
      expect(line).toMatch(/from "\.\//); // only relative, in-package imports
    }
  });
});
