import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultPoolConfig } from "./database.js";

const connectionString = process.env.DATABASE_URL;
const migrationApplied = await (async (): Promise<boolean> => {
  if (connectionString === undefined) return false;
  const pool = new Pool({ connectionString, ...defaultPoolConfig });
  try {
    const result = await pool.query<{ ready: boolean }>(
      `SELECT to_regclass('public.secret_values') = 'secret_values'::regclass
              AND EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'secret_values'
                            AND column_name = 'key_version') AS ready`,
    );
    return result.rows[0]?.ready === true;
  } finally {
    await pool.end();
  }
})();

const integration = migrationApplied ? describe : describe.skip;

integration("packages/db dynamic secret vault (TASK-192)", () => {
  let pool: Pool;
  const tenantId = "task-192-secret-vault-suite";
  const otherTenantId = "task-192-secret-vault-other-tenant";
  const ownerRoleId = "task-192-secret-vault-owner";
  const otherRoleId = "task-192-secret-vault-other";
  const options = { connectionString: connectionString! };
  const testKey = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)));

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await pool.query("DELETE FROM secret_values WHERE role_id = ANY($1::text[])", [[ownerRoleId, otherRoleId]]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [[ownerRoleId, otherRoleId]]);
    await pool.query(
      `INSERT INTO roles (role_id, tenant_id, name, title, description)
       VALUES ($1, $2, 'Vault owner', 'Vault owner', ''),
              ($3, $4, 'Vault other', 'Vault other', '')`,
      [ownerRoleId, tenantId, otherRoleId, otherTenantId],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM secret_values WHERE role_id = ANY($1::text[])", [[ownerRoleId, otherRoleId]]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [[ownerRoleId, otherRoleId]]);
    await pool.end();
  });

  async function vault() {
    const { createSecretVault } = await import("./secretVault.js");
    return createSecretVault({ resolveKey: async () => testKey });
  }

  it("round-trips byte-for-byte and never stores plaintext", async () => {
    const value = "sëcret value with unicode";
    const { storeSecret, resolveSecretValue } = await vault();
    const { ref } = await storeSecret(options, { tenantId, roleId: ownerRoleId, value });
    await expect(resolveSecretValue(options, ref, ownerRoleId, tenantId)).resolves.toBe(value);
    const raw = await pool.query<{ ciphertext: Buffer }>("SELECT ciphertext FROM secret_values WHERE ref = $1", [ref]);
    expect(raw.rows[0]?.ciphertext.equals(Buffer.from(value))).toBe(false);
    expect(raw.rows[0]?.ciphertext.toString("utf8")).not.toContain(value);
  });

  it("uses a fresh nonce on every write", async () => {
    const { storeSecret } = await vault();
    const refs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      storeSecret(options, { tenantId, roleId: ownerRoleId, value: `value-${i}` }),
    ));
    const rows = await pool.query<{ nonce: Buffer }>("SELECT nonce FROM secret_values WHERE ref = ANY($1::uuid[])", [refs.map(({ ref }) => ref)]);
    expect(new Set(rows.rows.map(({ nonce }) => nonce.toString("hex"))).size).toBe(refs.length);
  });

  it("makes missing, cross-role, and cross-tenant references indistinguishable", async () => {
    const { storeSecret, resolveSecretValue } = await vault();
    const { ref } = await storeSecret(options, { tenantId, roleId: ownerRoleId, value: "private" });
    const errors = await Promise.all([
      resolveSecretValue(options, "00000000-0000-0000-0000-000000000000", ownerRoleId, tenantId).then(() => null, (error: unknown) => error),
      resolveSecretValue(options, ref, otherRoleId, otherTenantId).then(() => null, (error: unknown) => error),
      resolveSecretValue(options, ref, ownerRoleId, otherTenantId).then(() => null, (error: unknown) => error),
    ]);
    expect(errors.every((error) => error instanceof Error)).toBe(true);
    expect(errors.map((error) => (error as Error).message)).toEqual(["Secret not found.", "Secret not found.", "Secret not found."]);
  });

  it("rejects ciphertext swapped between rows because AAD binds each row", async () => {
    const { storeSecret, resolveSecretValue } = await vault();
    const first = await storeSecret(options, { tenantId, roleId: ownerRoleId, value: "first" });
    const second = await storeSecret(options, { tenantId, roleId: ownerRoleId, value: "second" });
    const rows = await pool.query<{ ref: string; ciphertext: Buffer }>("SELECT ref, ciphertext FROM secret_values WHERE ref = ANY($1::uuid[])", [[first.ref, second.ref]]);
    const byRef = new Map(rows.rows.map((row) => [row.ref, row.ciphertext]));
    await pool.query("UPDATE secret_values SET ciphertext = CASE WHEN ref = $1 THEN $2 WHEN ref = $3 THEN $4 END WHERE ref IN ($1, $3)", [first.ref, byRef.get(second.ref), second.ref, byRef.get(first.ref)]);
    await expect(resolveSecretValue(options, first.ref, ownerRoleId, tenantId)).rejects.toThrow("Secret not found.");
    await expect(resolveSecretValue(options, second.ref, ownerRoleId, tenantId)).rejects.toThrow("Secret not found.");
  });
});

describe("packages/db secret vault configuration (TASK-192)", () => {
  it("imports without a configured key and validates only at factory construction", async () => {
    const previous = process.env.OIK_SECRET_VAULT_KEY;
    try {
      delete process.env.OIK_SECRET_VAULT_KEY;
      vi.resetModules();
      await expect(import("./secretVault.js")).resolves.toBeDefined();
      const { createSecretVault, resolveSecretVaultKey } = await import("./secretVault.js");
      await expect(createSecretVault({ resolveKey: resolveSecretVaultKey }))
        .rejects.toThrow("secret ref is unset");
      await expect(createSecretVault({ resolveKey: async () => Buffer.alloc(31) }))
        .rejects.toThrow("exactly 32 bytes");
      process.env.OIK_SECRET_VAULT_KEY = Buffer.from(
        globalThis.crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64");
      await expect(resolveSecretVaultKey()).resolves.toHaveLength(32);
    } finally {
      if (previous === undefined) delete process.env.OIK_SECRET_VAULT_KEY;
      else process.env.OIK_SECRET_VAULT_KEY = previous;
    }
  });
});
