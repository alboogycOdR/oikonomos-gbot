import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig } from "./database.js";
import { admitIntake, IntakeDigestMismatchError, lookupIntake } from "./intakeNonces.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

// Test-only fixture hashing. NOT `@oikonomos/shared`'s `actionDigest` —
// `packages/db`'s package.json does not (and, per this task's Owned_Paths,
// must not) declare a `@oikonomos/shared` dependency; that wiring belongs
// to the barrel-export follow-up task per the PLAN.md description. The
// production module (`intakeNonces.ts`) itself never computes a digest —
// callers are expected to use `@oikonomos/shared` for that — so an opaque
// deterministic string fixture here exercises the ledger mechanics
// (admit/replay/mismatch) exactly as well as a real actionDigest would.
function digestFor(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

integration("packages/db intakeNonces — admitIntake / lookupIntake (TASK-075)", () => {
  let pool: Pool;
  const tenantId = "task-075-fixture-tenant";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM intake_nonces WHERE tenant_id = $1`, [tenantId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("admits a new nonce as dispatch, and replays the identical nonce+digest as duplicate", async () => {
    const clientNonce = "nonce-basic-1";
    const digest = digestFor("hello world");

    const first = await admitIntake({ connectionString: connectionString! }, {
      tenantId,
      clientNonce,
      inputDigest: digest,
    });
    expect(first.status).toBe("dispatch");
    expect(first.record.clientNonce).toBe(clientNonce);
    expect(first.record.inputDigest).toBe(digest);
    expect(first.record.taskId).toBeNull();

    const second = await admitIntake({ connectionString: connectionString! }, {
      tenantId,
      clientNonce,
      inputDigest: digest,
    });
    expect(second.status).toBe("duplicate");
    expect(second.record.intakeId).toBe(first.record.intakeId);
  });

  it("MUTATION-PROVEN: concurrent same-nonce admits yield exactly one dispatch, the rest duplicate", async () => {
    const clientNonce = "nonce-concurrent-1";
    const digest = digestFor("same content, retried N times");

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        admitIntake(
          { connectionString: connectionString! },
          { tenantId, clientNonce, inputDigest: digest },
        ),
      ),
    );

    const dispatches = results.filter((r) => r.status === "dispatch");
    const duplicates = results.filter((r) => r.status === "duplicate");
    expect(dispatches).toHaveLength(1);
    expect(duplicates).toHaveLength(7);
    // Every result — winner and replays alike — resolves to the same row.
    const intakeIds = new Set(results.map((r) => r.record.intakeId));
    expect(intakeIds.size).toBe(1);
  });

  it("same nonce with a DIFFERENT digest raises IntakeDigestMismatchError, never a silent duplicate", async () => {
    const clientNonce = "nonce-mismatch-1";
    const digestA = digestFor("original content");
    const digestB = digestFor("swapped content");

    await admitIntake(
      { connectionString: connectionString! },
      { tenantId, clientNonce, inputDigest: digestA },
    );

    await expect(
      admitIntake(
        { connectionString: connectionString! },
        { tenantId, clientNonce, inputDigest: digestB },
      ),
    ).rejects.toThrow(IntakeDigestMismatchError);

    // The original row is untouched by the failed mismatched attempt.
    const record = await lookupIntake(
      { connectionString: connectionString! },
      { tenantId, clientNonce },
    );
    expect(record?.inputDigest).toBe(digestA);
  });

  it("two tenants may reuse the same client_nonce independently (UNIQUE is per-tenant)", async () => {
    const clientNonce = "nonce-shared-across-tenants";
    const digest = digestFor("cross-tenant payload");
    const otherTenant = `${tenantId}-other`;

    try {
      const a = await admitIntake(
        { connectionString: connectionString! },
        { tenantId, clientNonce, inputDigest: digest },
      );
      const b = await admitIntake(
        { connectionString: connectionString! },
        { tenantId: otherTenant, clientNonce, inputDigest: digest },
      );
      expect(a.status).toBe("dispatch");
      expect(b.status).toBe("dispatch");
      expect(a.record.intakeId).not.toBe(b.record.intakeId);
    } finally {
      await pool.query(`DELETE FROM intake_nonces WHERE tenant_id = $1`, [otherTenant]);
    }
  });

  it("lookupIntake returns null for an unknown nonce (tri-state found | not-found)", async () => {
    const record = await lookupIntake(
      { connectionString: connectionString! },
      { tenantId, clientNonce: "nonce-never-admitted" },
    );
    expect(record).toBeNull();
  });
});

// NOT gated behind `integration` — same rationale as runs.test.ts's sibling
// pin: this reads the compiled source off disk and needs no database, so it
// must run unconditionally (the default CI `pnpm test` job carries no
// DATABASE_URL).
describe("intakeNonces — digest discipline source-level pins (N10)", () => {
  it("MUTATION-PROVEN: the module never imports node:crypto — the input digest must come exclusively from @oikonomos/shared", () => {
    const src = readFileSync(new URL("./intakeNonces.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/node:crypto/);
    expect(src).not.toMatch(/from ["']crypto["']/);
  });

  it("the write path is a single INSERT ... ON CONFLICT statement (atomicity for concurrent admits)", () => {
    const src = readFileSync(new URL("./intakeNonces.ts", import.meta.url), "utf8");
    expect(src).toMatch(/INSERT INTO intake_nonces[\s\S]*ON CONFLICT \(tenant_id, client_nonce\) DO NOTHING/);
  });
});
