import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function readSrcFiles(): { name: string; body: string }[] {
  return readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      body: readFileSync(join(srcDir, name), "utf8"),
    }));
}

describe("N10 — no local canonical JSON or sha256", () => {
  it("imports actionDigest from @oikonomos/shared and never reimplements it", () => {
    const files = readSrcFiles();
    const bind = files.find((file) => file.name === "bind.ts");
    expect(bind).toBeDefined();
    expect(bind!.body).toMatch(/from ["']@oikonomos\/shared["']/);
    expect(bind!.body).toMatch(/actionDigest/);

    for (const file of files) {
      expect(file.body, file.name).not.toMatch(/createHash\s*\(/);
      expect(file.body, file.name).not.toMatch(/createHmac\s*\(/);
      expect(file.body, file.name).not.toMatch(/function\s+canonicalJson\b/);
      expect(file.body, file.name).not.toMatch(/from ["']node:crypto["'].*createHash/s);
    }
  });
});
