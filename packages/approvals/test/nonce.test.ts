import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { generateNonce } from "../src/nonce.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generateNonce", () => {
  it("returns a UUID v4", () => {
    expect(generateNonce()).toMatch(UUID_V4);
  });

  it("is unique under concurrent issuance", async () => {
    const nonces = await Promise.all(
      Array.from({ length: 200 }, () => Promise.resolve(generateNonce())),
    );
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("is sourced from node:crypto.randomUUID, not Math.random or a counter", () => {
    const source = readFileSync(new URL("../src/nonce.ts", import.meta.url), "utf8");
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(executable).toMatch(/from ["']node:crypto["']/);
    expect(executable).toMatch(/randomUUID/);
    expect(executable).not.toMatch(/Math\.random/);
    expect(executable).not.toMatch(/\bcounter\b/);
  });
});
