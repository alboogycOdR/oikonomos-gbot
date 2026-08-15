import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EXPIRE_PENDING_SQL, INVALIDATE_APPROVAL_SQL } from "../src/store.js";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

describe("OIK-023 / OIK-024 — pinned status-transition statements", () => {
  it("invalidates only granted unused rows for one nonce", () => {
    expect(INVALIDATE_APPROVAL_SQL).toBe(
      `UPDATE approvals SET status='invalidated'\nWHERE nonce=$1 AND status='granted' AND consumed_at IS NULL`,
    );
  });

  it("expires only pending rows whose expiry has elapsed", () => {
    expect(EXPIRE_PENDING_SQL).toBe(
      `UPDATE approvals SET status='expired'\nWHERE status='pending' AND expires_at<=now()`,
    );
  });

  it("does not reimplement consume SQL and keeps invalidate/expire as single UPDATEs", () => {
    const store = readFileSync(join(srcDir, "store.ts"), "utf8");
    expect(store).not.toMatch(/UPDATE approvals SET status='consumed'/);
    expect(store).toContain("INVALIDATE_APPROVAL_SQL");
    expect(store).toContain("EXPIRE_PENDING_SQL");
    expect(store).not.toMatch(/\bBEGIN\b/);
    expect(store).not.toMatch(/\bCOMMIT\b/);

    for (const name of readdirSync(srcDir).filter((file) => file.endsWith(".ts"))) {
      if (name === "store.ts") {
        continue;
      }
      const body = readFileSync(join(srcDir, name), "utf8");
      expect(body, name).not.toMatch(/UPDATE approvals SET status=/);
    }
  });
});
