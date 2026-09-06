import { randomBytes } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultPoolConfig } from "./database.js";

const vaultKey = randomBytes(32).toString("base64");
const previousVaultKey = process.env.OIK_SECRET_VAULT_KEY;
process.env.OIK_SECRET_VAULT_KEY = vaultKey;

const connectionString = process.env.DATABASE_URL;
const migrationApplied = await (async (): Promise<boolean> => {
  if (connectionString === undefined) return false;
  const pool = new Pool({ connectionString, ...defaultPoolConfig });
  try {
    const result = await pool.query<{ secret_values: string | null }>(
      "SELECT to_regclass('public.secret_values') AS secret_values",
    );
    return result.rows[0]?.secret_values === "secret_values";
  } finally {
    await pool.end();
  }
})();

const integration = migrationApplied ? describe : describe.skip;

integration("packages/db dynamic secret vault (TASK-192)", () => {
  let pool: Pool;
  const tenantId = "task-192-secret-vault-suite";
  const ownerRoleId = "task-192-secret-vault-owner";
  const otherRoleId = "task-192-secret-vault-other";
  const options = { connectionString: connectionString! };

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await pool.query("DELETE FROM secret_values WHERE role_id = ANY($1::text[])", [[ownerRoleId, otherRoleId]]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [[ownerRoleId, otherRoleId]]);
    await pool.query(
      `INSERT INTO roles (role_id, tenant_id, name, title, description)
       VALUES ($1, $2, 'Vault owner', 'Vault owner', ''),
              ($3, $2, 'Vault other', 'Vault other', '')`,
      [ownerRoleId, tenantId, otherRoleId],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM secret_values WHERE role_id = ANY($1::text[])", [[ownerRoleId, otherRoleId]]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [[ownerRoleId, otherRoleId]]);
    await pool.end();
  });

  it("round-trips exactly, with raw ciphertext distinct from plaintext", async () => {
    const { storeSecret, resolveSecretValue } = await import("./secretVault.js");
    const plaintext = "correct horse battery staple 🔐";
    const { ref } = await storeSecret(options, { tenantId, roleId: ownerRoleId, value: plaintext });

    expect(await resolveSecretValue(options, ref, ownerRoleId)).toBe(plaintext);
    const stored = await pool.query<{ ciphertext: Buffer }>(
      "SELECT ciphertext FROM secret_values WHERE ref = $1",
      [ref],
    );
    const ciphertext = stored.rows[0]?.ciphertext;
    expect(ciphertext).toBeDefined();
    expect(ciphertext).not.toEqual(Buffer.from(plaintext, "utf8"));
    expect(ciphertext?.toString("utf8")).not.toContain(plaintext);
  });

  it("uses a distinct random nonce for every stored value", async () => {
    const { storeSecret } = await import("./secretVault.js");
    const refs = await Promise.all(Array.from({ length: 6 }, async (_, index) => (
      storeSecret(options, { tenantId, roleId: ownerRoleId, value: `value-${index}` })
    )));
    const rows = await pool.query<{ nonce: Buffer }>(
      "SELECT nonce FROM secret_values WHERE ref = ANY($1::uuid[])",
      [refs.map(({ ref }) => ref)],
    );
    const nonces = rows.rows.map(({ nonce }) => nonce.toString("hex"));
    expect(nonces).toHaveLength(refs.length);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("makes missing and cross-role refs indistinguishable", async () => {
    const { storeSecret, resolveSecretValue } = await import("./secretVault.js");
    const { ref } = await storeSecret(options, { tenantId, roleId: ownerRoleId, value: "private" });

    const missing = await resolveSecretValue(options, "00000000-0000-0000-0000-000000000000", otherRoleId)
      .then(() => null, (error: unknown) => error);
    const crossRole = await resolveSecretValue(options, ref, otherRoleId)
      .then(() => null, (error: unknown) => error);
    expect(missing).toBeInstanceOf(Error);
    expect(crossRole).toBeInstanceOf(Error);
    expect((crossRole as Error).message).toBe((missing as Error).message);
    expect((crossRole as Error).name).toBe((missing as Error).name);
  });
});

describe("packages/db secret vault configuration (TASK-192)", () => {
  afterAll(() => {
    if (previousVaultKey === undefined) delete process.env.OIK_SECRET_VAULT_KEY;
    else process.env.OIK_SECRET_VAULT_KEY = previousVaultKey;
  });

  it("fails during module import when the vault key is absent or wrong-sized", async () => {
    for (const key of [undefined, Buffer.alloc(31).toString("base64")]) {
      if (key === undefined) delete process.env.OIK_SECRET_VAULT_KEY;
      else process.env.OIK_SECRET_VAULT_KEY = key;
      vi.resetModules();
      await expect(import("./secretVault.js"))
        .rejects.toThrow(/OIK_SECRET_VAULT_KEY/);
    }
    process.env.OIK_SECRET_VAULT_KEY = vaultKey;
    vi.resetModules();
  });
});
