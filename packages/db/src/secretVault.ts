import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

/**
 * TASK-192 / ADR-014 §3 — dynamic secret vault storage.
 *
 * `ciphertext` stores the AES-256-GCM encrypted bytes followed immediately
 * by the 16-byte GCM authentication tag. `nonce` stores the fresh 12-byte
 * nonce generated for that encryption. The vault key is loaded at module
 * evaluation so a misconfigured process fails closed before it can accept
 * work it cannot fulfil.
 *
 * v1 uses one persisted key and deliberately has no key-rotation mechanism;
 * see ADR-014 §3 for that known limitation.
 */

const VAULT_KEY_ENV = "OIK_SECRET_VAULT_KEY";
const GCM_NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const SECRET_NOT_FOUND_MESSAGE = "Secret not found.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadVaultKey(): Buffer {
  const configured = process.env[VAULT_KEY_ENV];
  if (configured === undefined || configured.trim().length === 0) {
    throw new Error(`${VAULT_KEY_ENV} must be set to a base64-encoded 32-byte key.`);
  }

  const encoded = configured.trim();
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error(`${VAULT_KEY_ENV} must decode to exactly 32 bytes.`);
  }
  return key;
}

const vaultKey = loadVaultKey();

interface SecretValueRow extends QueryResultRow {
  ref: string;
  ciphertext: Buffer;
  nonce: Buffer;
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

async function withPool<T>(
  options: DatabaseOptions,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  if (options.connectionString.trim().length === 0) {
    throw new Error("Database connectionString must not be empty.");
  }

  const pool = new Pool({
    connectionString: options.connectionString,
    ...defaultPoolConfig,
    ...options.poolConfig,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export interface NewSecretValue {
  tenantId: string;
  roleId: string;
  value: string;
}

/** Encrypt and persist a secret, returning its opaque UUID reference. */
export async function storeSecret(
  options: DatabaseOptions,
  input: NewSecretValue,
): Promise<{ ref: string }> {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const roleId = requireNonEmpty(input.roleId, "roleId");
  if (typeof input.value !== "string") {
    throw new Error("value must be a string.");
  }
  const nonce = randomBytes(GCM_NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", vaultKey, nonce);
  const encrypted = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);

  return withPool(options, async (pool) => {
    const result = await pool.query<Pick<SecretValueRow, "ref">>(
      `INSERT INTO secret_values (tenant_id, role_id, ciphertext, nonce)
       VALUES ($1, $2, $3, $4)
       RETURNING ref`,
      [tenantId, roleId, ciphertext, nonce],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("storeSecret did not return a persisted ref.");
    }
    return { ref: row.ref };
  });
}

/**
 * Resolve a secret only when its owner is the requesting role. Missing and
 * cross-role references both produce the same generic error by filtering the
 * role in SQL rather than fetching a row and comparing it in application code.
 */
export async function resolveSecretValue(
  options: DatabaseOptions,
  ref: string,
  requestingRoleId: string,
): Promise<string> {
  if (typeof ref !== "string" || !UUID_RE.test(ref)) {
    throw notFound();
  }
  const roleId = requireNonEmpty(requestingRoleId, "requestingRoleId");

  return withPool(options, async (pool) => {
    const result = await pool.query<SecretValueRow>(
      `SELECT ciphertext, nonce FROM secret_values
       WHERE ref = $1 AND role_id = $2`,
      [ref, roleId],
    );
    const row = result.rows[0];
    if (row === undefined || row.ciphertext.length < GCM_TAG_LENGTH) {
      throw notFound();
    }

    try {
      const tagStart = row.ciphertext.length - GCM_TAG_LENGTH;
      const decipher = createDecipheriv("aes-256-gcm", vaultKey, row.nonce);
      decipher.setAuthTag(row.ciphertext.subarray(tagStart));
      return Buffer.concat([
        decipher.update(row.ciphertext.subarray(0, tagStart)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Do not expose whether a row existed but failed authentication.
      throw notFound();
    }
  });
}
