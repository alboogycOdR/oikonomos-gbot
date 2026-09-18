import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scanner = join(repoRoot, "infra", "ci", "banned-modes.mjs");

describe("CAN-03 — banned permission modes", () => {
  // A whole-repository scan took about 4.85s when TASK-294 was filed. Leave
  // headroom for repository growth and concurrent CI filesystem activity.
  it("reuses the ADR-002 scanner for both clean and planted-violation scans", () => {
    const result = spawnSync(process.execPath, [scanner], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toMatch(/banned-modes: clean/);

    const plantedToken = ["bypass", "Permissions"].join("");
    const tempDir = mkdtempSync(join(repoRoot, "evals", "harness", "test", ".can-03-"));
    try {
      writeFileSync(
        join(tempDir, "planted-violation.ts"),
        `export const planted = ${JSON.stringify(plantedToken)};\n`,
        "utf8",
      );

      const violationResult = spawnSync(process.execPath, [scanner], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(violationResult.error).toBeUndefined();
      expect(violationResult.status, violationResult.stderr || violationResult.stdout).toBe(1);
      expect(violationResult.stderr).toMatch(/banned-modes: [1-9]\d* hit\(s\)/);
      expect(violationResult.stderr).toContain("planted-violation.ts");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
