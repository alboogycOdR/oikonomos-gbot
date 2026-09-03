import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultManifestsDir } from "./scan.js";
import { InvalidManifestError, loadManifests } from "./load.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "oik-conn-load-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VALID_MANIFEST = `
connector_id: fixture-connector
account_ownership: basileia
mcp_server: { name: fixture-connector, transport: remote, url_ref: secret://mcp/fixture/url }
oauth_scopes: [scope.read]
tools:
  - tool_name: mcp__fixture-connector__read
    capability_id: fixture.read
    default_tier: T0_observe
role_grants: []
evals: { suite: evals/golden/fixture-connector, min_pass_rate: 0.90 }
review: { onboarded_by: "", date: "", scope_justification: "" }
`;

const INVALID_MANIFEST = `
connector_id: broken-connector
# missing account_ownership, mcp_server, tools -- fails schema validation
`;

describe("loadManifests (ADR-013 §2)", () => {
  it("returns 3 validated ConnectorManifest objects for the real manifests directory", async () => {
    const manifests = await loadManifests(defaultManifestsDir());

    expect(manifests).toHaveLength(3);
    const ids = manifests.map((manifest) => manifest.connector_id).sort();
    expect(ids).toEqual(["gmail", "google-calendar", "google-drive"]);
    for (const manifest of manifests) {
      expect(manifest.account_ownership).toBe("basileia");
      expect(Array.isArray(manifest.tools)).toBe(true);
      expect(manifest.tools.length).toBeGreaterThan(0);
    }
  });

  it("returns real parsed manifest content, not just file names", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "fixture.yaml"), VALID_MANIFEST, "utf8");
      const manifests = await loadManifests(dir);
      expect(manifests).toHaveLength(1);
      expect(manifests[0].connector_id).toBe("fixture-connector");
      expect(manifests[0].tools[0].capability_id).toBe("fixture.read");
    });
  });

  it("throws InvalidManifestError (does not silently skip) on a manifest failing validateManifest", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "fixture.yaml"), VALID_MANIFEST, "utf8");
      await writeFile(join(dir, "broken.yaml"), INVALID_MANIFEST, "utf8");

      await expect(loadManifests(dir)).rejects.toThrow(InvalidManifestError);
      await expect(loadManifests(dir)).rejects.toThrow(/broken\.yaml/);
    });
  });

  it("throws (not an empty array) when the directory is missing", async () => {
    const missing = join(tmpdir(), `oik-conn-load-missing-${Date.now()}`);
    await expect(loadManifests(missing)).rejects.toThrow(/UNOBSERVABLE/);
  });

  it("throws when the directory has zero manifests", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "readme.txt"), "not a manifest\n", "utf8");
      await expect(loadManifests(dir)).rejects.toThrow(/UNOBSERVABLE/);
    });
  });
});
