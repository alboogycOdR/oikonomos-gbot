import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";

/**
 * TASK-192 / ADR-014 §3 — dynamic secret vault storage.
 *
 * `ciphertext` stores WebCrypto AES-256-GCM's complete output: encrypted
 * bytes followed immediately by its 16-byte authentication tag. `nonce`
 * stores the fresh 12-byte nonce generated for that encryption. Every value
 * is additionally authenticated against its canonical row identity, so a
 * ciphertext copied into another row cannot decrypt.
 *
 * v1 uses one persisted key and deliberately has no key-rotation mechanism;
 * see ADR-014 §3 for that known limitation.
 */

const GCM_NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const SECRET_NOT_FOUND_MESSAGE = "Secret not found.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SECRET_VAULT_KEY_REF = "secret://vault/key";

interface SecretValueRow extends QueryResultRow {
  ref: string;
  tenant_id: string;
  role_id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  key_version: number;
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function notFound(): Error {
  return new Error(SECRET_NOT_FOUND_MESSAGE);
}

export interface NewSecretValue {
  tenantId: string;
  roleId: string;
  value: string;
}

export const SECRET_VAULT_WRITE_EVENT = "secret_vault.write";
export const SECRET_VAULT_READ_EVENT = "secret_vault.read";

export interface SecretVault {
  storeSecret(options: DatabaseOptions, input: NewSecretValue): Promise<{ ref: string }>;
  resolveSecretValue(
    options: DatabaseOptions,
    ref: string,
    requestingRoleId: string,
    requestingTenantId: string,
  ): Promise<string>;
}

export interface CreateSecretVaultOptions {
  /** Resolves `secret://vault/key` using the established env-secret convention. */
  resolveKey: () => Promise<Buffer>;
}

/**
 * Local form of the established `secret://` environment resolver. This keeps
 * @oikonomos/db free of a new cross-package dependency while deriving the
 * same `OIK_SECRET_VAULT_KEY` name from `secret://vault/key`.
 */
export async function resolveSecretVaultKey(): Promise<Buffer> {
  const envKey = `OIK_SECRET_${SECRET_VAULT_KEY_REF.slice("secret://".length)
    .replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
  const value = process.env[envKey];
  if (value === undefined || value.length === 0) {
    throw new Error(`secret ref is unset: ${SECRET_VAULT_KEY_REF}`);
  }
  return Buffer.from(value, "base64");
}

function rowAad(row: Pick<SecretValueRow, "ref" | "tenant_id" | "role_id" | "key_version">): Uint8Array {
  // The key names are lexicographically ordered, which is the canonical JSON
  // representation for this fixed primitive-only object.
  return new TextEncoder().encode(JSON.stringify({
    key_version: row.key_version,
    ref: row.ref,
    role_id: row.role_id,
    tenant_id: row.tenant_id,
  }));
}

/**
 * Constructs a vault at service startup. Importing this module has no key
 * side effects; an absent or wrong-sized key fails only construction.
 */
export async function createSecretVault(
  options: CreateSecretVaultOptions,
): Promise<SecretVault> {
  const rawKey = await options.resolveKey();
  if (!Buffer.isBuffer(rawKey) || rawKey.length !== 32) {
    throw new Error("secret vault key must resolve to exactly 32 bytes.");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"],
  );

  return {
    async storeSecret(databaseOptions, input) {
      const tenantId = requireNonEmpty(input.tenantId, "tenantId");
      const roleId = requireNonEmpty(input.roleId, "roleId");
      if (typeof input.value !== "string") throw new Error("value must be a string.");

      return withPool(databaseOptions, async (pool) => {
        const ref = globalThis.crypto.randomUUID();
        const keyVersion = 1;
        const nonce = new Uint8Array(GCM_NONCE_LENGTH);
        globalThis.crypto.getRandomValues(nonce);
        const ciphertext = await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: rowAad({ ref, tenant_id: tenantId, role_id: roleId, key_version: keyVersion }) },
          key,
          new TextEncoder().encode(input.value),
        );
        const result = await pool.query<Pick<SecretValueRow, "ref">>(
          `INSERT INTO secret_values (ref, tenant_id, role_id, ciphertext, nonce, key_version)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ref`,
          [ref, tenantId, roleId, Buffer.from(ciphertext), Buffer.from(nonce), keyVersion],
        );
        if (result.rows[0] === undefined) throw new Error("storeSecret did not return a persisted ref.");
        return { ref };
      });
    },

    async resolveSecretValue(databaseOptions, ref, requestingRoleId, requestingTenantId) {
      if (typeof ref !== "string" || !UUID_RE.test(ref)) throw notFound();
      const roleId = requireNonEmpty(requestingRoleId, "requestingRoleId");
      const tenantId = requireNonEmpty(requestingTenantId, "requestingTenantId");
      return withPool(databaseOptions, async (pool) => {
        const result = await pool.query<SecretValueRow>(
          `SELECT ref, tenant_id, role_id, ciphertext, nonce, key_version FROM secret_values
           WHERE ref = $1 AND role_id = $2 AND tenant_id = $3`,
          [ref, roleId, tenantId],
        );
        const row = result.rows[0];
        if (row === undefined || row.ciphertext.length < GCM_TAG_LENGTH) throw notFound();
        try {
          const plaintext = await globalThis.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: row.nonce, additionalData: rowAad(row) }, key, row.ciphertext,
          );
          return new TextDecoder().decode(plaintext);
        } catch {
          // Internal callers may log this corruption event; callers see the same opaque error.
          throw notFound();
        }
      });
    },
  };
}
