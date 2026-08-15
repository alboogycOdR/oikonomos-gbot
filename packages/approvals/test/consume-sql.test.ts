import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONSUME_APPROVAL_SQL } from "../../db/src/approvals.js";

const PINNED_STATEMENT = `UPDATE approvals SET status='consumed', consumed_at=now()
WHERE nonce=$1 AND status='granted' AND expires_at>now() AND consumed_at IS NULL`;

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const dbApprovalsPath = fileURLToPath(new URL("../../db/src/approvals.ts", import.meta.url));

describe("N8 — consume is one pinned atomic statement", () => {
  it("exports the exact Handover §4.3 / Synthesis §5.2 statement", () => {
    expect(CONSUME_APPROVAL_SQL).toBe(PINNED_STATEMENT);
  });

  it("consumeApproval issues that one UPDATE and does not check-then-update", () => {
    const source = readFileSync(dbApprovalsPath, "utf8");
    const start = source.indexOf("export async function consumeApproval");
    expect(start).toBeGreaterThanOrEqual(0);
    const consumeFn = source.slice(start);

    expect(consumeFn).toContain("CONSUME_APPROVAL_SQL");
    expect(consumeFn).toMatch(/RETURNING/);
    expect(consumeFn).not.toMatch(/\bBEGIN\b/);
    expect(consumeFn).not.toMatch(/\bCOMMIT\b/);
    expect(consumeFn).not.toMatch(/\bSELECT\b/);
    expect((consumeFn.match(/pool\.query/g) ?? []).length).toBe(1);
  });

  it("does not reimplement consume SQL inside packages/approvals/src", () => {
    const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const body = readFileSync(join(srcDir, name), "utf8");
      expect(body, name).not.toMatch(/UPDATE approvals SET status='consumed'/);
    }
  });
});
