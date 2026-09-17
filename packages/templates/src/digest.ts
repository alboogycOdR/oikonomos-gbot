import { createHash } from "node:crypto";

import { canonicalJson } from "@oikonomos/shared";

import type { TemplateManifest } from "./manifest.js";

/**
 * The template digest — spec §2.2: "`digest` = `packages/shared` canonical
 * JSON digest of the manifest with `provenance` excluded. Two exports of an
 * unchanged bot produce the same digest." Reuses the platform's single
 * canonical-JSON implementation (N10) rather than serializing by hand, so
 * this digest agrees byte-for-byte with any other consumer of
 * `canonicalJson`. `provenance` (export timestamp, source-tenant digest,
 * platform version) is excluded by construction: none of those fields
 * describe the bot itself, so two exports of an otherwise-identical bot a
 * minute apart must produce the same digest.
 */
export function templateDigest(manifest: TemplateManifest): string {
  const { provenance: _provenance, ...withoutProvenance } = manifest;
  const canonical = canonicalJson(withoutProvenance);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  function manifest(overrides: Partial<TemplateManifest> = {}): TemplateManifest {
    return {
      template_version: 1,
      identity: {
        name: "support-bot",
        title: "Support Bot",
        description: "Handles support tickets.",
        instructions: null,
        provider: null,
        model: null,
      },
      skills: [],
      routines: [],
      integrations: [],
      memories: [],
      provenance: {
        exported_at: "2026-09-17T00:00:00.000Z",
        exported_from_tenant_digest: "digest-abc",
        oikonomos_version: "0.0.0",
      },
      ...overrides,
    };
  }

  describe("templateDigest", () => {
    it("is stable: the same manifest content produces the same digest twice", () => {
      const a = templateDigest(manifest());
      const b = templateDigest(manifest());
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is unaffected by provenance -- two exports of an unchanged bot match", () => {
      const first = templateDigest(
        manifest({
          provenance: {
            exported_at: "2026-09-17T00:00:00.000Z",
            exported_from_tenant_digest: "digest-abc",
            oikonomos_version: "0.0.0",
          },
        }),
      );
      const second = templateDigest(
        manifest({
          provenance: {
            exported_at: "2026-09-18T12:34:56.000Z",
            exported_from_tenant_digest: "digest-xyz",
            oikonomos_version: "0.1.0",
          },
        }),
      );
      expect(first).toBe(second);
    });

    it("changes when manifest content changes", () => {
      const a = templateDigest(manifest());
      const b = templateDigest(manifest({ identity: { ...manifest().identity, title: "Different Title" } }));
      expect(a).not.toBe(b);
    });
  });
}
