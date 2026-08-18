import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scanner = join(repoRoot, "infra", "ci", "banned-modes.mjs");

describe("CAN-03 — banned permission modes", () => {
  it("reuses the ADR-002 scanner and finds zero hits outside the allowlist", () => {
    const result = spawnSync(process.execPath, [scanner], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toMatch(/banned-modes: clean/);
  });
});
