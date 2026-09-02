import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SEALED_SECRET_ROOT } from "./sealedSecretRoot.js";

const brokerGuardSource = readFileSync(
  fileURLToPath(new URL("../../broker/src/secretPathGuard.ts", import.meta.url)),
  "utf8",
);
const workspacePathsSource = readFileSync(
  fileURLToPath(new URL("../../../services/workspace/src/paths.ts", import.meta.url)),
  "utf8",
);

describe("SEALED_SECRET_ROOT", () => {
  it("is the canonical D3 root used by both guards", () => {
    expect(SEALED_SECRET_ROOT).toBe("/oikonomos/secrets");
    expect(brokerGuardSource).toMatch(
      /import\s*\{\s*SEALED_SECRET_ROOT\s*\}\s*from\s*"@oikonomos\/shared"/,
    );
    expect(workspacePathsSource).toMatch(
      /import\s*\{\s*SEALED_SECRET_ROOT\s*\}\s*from\s*"@oikonomos\/shared"/,
    );
  });
});
