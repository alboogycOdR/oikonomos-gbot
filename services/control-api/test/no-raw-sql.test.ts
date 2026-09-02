import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * TASK-056 / OIK-084 liveness check: "no raw SQL here" is a mechanical
 * control, so it needs a check that fails when the control is inert
 * (CLAUDE.md "every mechanical control ships a liveness assertion").
 * This scans every source file this package owns for the two ways raw
 * SQL could sneak back in: importing `pg` directly (bypassing the
 * @oikonomos/db / @oikonomos/approvals ports) or a bare SQL keyword
 * string literal.
 */
const SOURCE_FILES = ["app.ts", "auth.ts", "index.ts", "openapi.ts", "ports.ts", "redact.ts"];

function readSource(name: string): string {
  const path = fileURLToPath(new URL(`../src/${name}`, import.meta.url));
  return readFileSync(path, "utf8");
}

describe("control-api liveness: no raw SQL, no direct pg import", () => {
  it.each(SOURCE_FILES)("%s does not import 'pg'", (name) => {
    const source = readSource(name);
    expect(source).not.toMatch(/from\s+["']pg["']/);
    expect(source).not.toMatch(/require\(["']pg["']\)/);
  });

  it.each(SOURCE_FILES)("%s contains no SQL statement keywords", (name) => {
    const source = readSource(name);
    expect(source).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i);
  });

  it("package.json declares no direct dependency on 'pg'", () => {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.pg).toBeUndefined();
  });

  it("this test would fail if a source file imported pg (self-check)", () => {
    const guilty = 'import { Pool } from "pg";';
    expect(guilty).toMatch(/from\s+["']pg["']/);
  });
});
