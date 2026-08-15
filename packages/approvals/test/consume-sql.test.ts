import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONSUME_APPROVAL_SQL, consumeApproval } from "@oikonomos/db";
import { describe, expect, it } from "vitest";

const PINNED_STATEMENT = `UPDATE approvals SET status='consumed', consumed_at=now()
WHERE nonce=$1 AND status='granted' AND expires_at>now() AND consumed_at IS NULL`;

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const testDir = fileURLToPath(new URL(".", import.meta.url));

describe("N8 — consume is one pinned atomic statement", () => {
  it("exports the exact Handover §4.3 / Synthesis §5.2 statement", () => {
    expect(CONSUME_APPROVAL_SQL).toBe(PINNED_STATEMENT);
  });

  it("consumeApproval issues that one UPDATE and does not check-then-update", () => {
    const consumeFn = consumeApproval.toString();

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

  it("loads consumeApproval from @oikonomos/db rather than a sibling filesystem path", () => {
    const store = readFileSync(join(srcDir, "store.ts"), "utf8");
    expect(store).toMatch(/consumeApproval/);
    expect(store).toMatch(/from ["']@oikonomos\/db["']/);
    expect(store).not.toMatch(/db\/dist\/approvals/);
    expect(store).not.toMatch(/loadConsumeApproval/);
  });

  it("pins CONSUME_APPROVAL_SQL from the executed @oikonomos/db export, not sibling src", () => {
    const files = readdirSync(testDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const body = readFileSync(join(testDir, name), "utf8");
      expect(body, name).not.toMatch(/db\/src\/approvals/);
    }
  });
});
