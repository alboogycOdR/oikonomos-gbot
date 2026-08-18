import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultManifestsDir,
  scanManifests,
  UNOBSERVABLE_MISSING_DIR,
  UNOBSERVABLE_ZERO_MANIFESTS,
  validateManifest,
} from "../src/index.js";
import { handoverGmailObject, handoverGmailYaml, yamlFrom } from "./helpers.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "oik-conn-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("scanManifests liveness (ADR-005)", () => {
  it("fails as unobservable when the manifests directory is missing", async () => {
    const missing = join(tmpdir(), `oik-conn-missing-${Date.now()}-no-such-dir`);
    const result = await scanManifests(missing);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.unobservable).toBe("missing_dir");
    expect(result.message.startsWith(UNOBSERVABLE_MISSING_DIR)).toBe(true);
  });

  it("fails as unobservable when the directory exists but matches zero manifests", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "readme.txt"), "not a manifest\n", "utf8");
      const result = await scanManifests(dir);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.unobservable).toBe("zero_manifests");
      expect(result.message.startsWith(UNOBSERVABLE_ZERO_MANIFESTS)).toBe(true);
    });
  });

  it("self-anchor: scanning a known fixture actually parsed the gmail document", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "gmail.yaml"), handoverGmailYaml(), "utf8");
      const result = await scanManifests(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.files).toEqual(["gmail.yaml"]);
    });

    const parsed = validateManifest(handoverGmailYaml());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.manifest.connector_id).toBe("gmail");
    expect(parsed.manifest.tools[2]?.capability_id).toBe("email.send");
    expect(parsed.manifest.tools[2]?.enabled).toBe(false);
    expect(parsed.manifest.role_grants[0]?.constraints.rate_per_hour).toBe(40);
  });

  it("names file and field for every violation", async () => {
    await withTempDir(async (dir) => {
      const badOwnership = handoverGmailObject();
      badOwnership.account_ownership = "employer";
      const badTier = handoverGmailObject();
      const tools = badTier.tools as Array<Record<string, unknown>>;
      tools[0] = { ...tools[0], default_tier: "not_a_tier" };

      await mkdir(join(dir, "nested"), { recursive: true });
      await writeFile(join(dir, "bad-owner.yaml"), yamlFrom(badOwnership), "utf8");
      await writeFile(join(dir, "nested", "bad-tier.yml"), yamlFrom(badTier), "utf8");

      const result = await scanManifests(dir);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      const fields = result.violations.map((v) => `${v.file}:${v.field}`);
      expect(fields.some((line) => line === "bad-owner.yaml:account_ownership")).toBe(
        true,
      );
      expect(fields.some((line) => line.includes("nested/bad-tier.yml"))).toBe(true);
      expect(fields.some((line) => line.includes("default_tier"))).toBe(true);
    });
  });

  it("self-anchor against the live manifests directory (defaultManifestsDir)", async () => {
    const dir = defaultManifestsDir();
    const result = await scanManifests(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files).toContain("gmail.yaml");
  });
});
