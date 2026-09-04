import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

export const devicePlatforms = ["android", "ios", "web"] as const;
export type DevicePlatform = (typeof devicePlatforms)[number];

export interface DeviceToken {
  token: string;
  platform: DevicePlatform;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface RegisterDeviceTokenInput {
  token: string;
  platform: DevicePlatform;
}

interface DeviceTokenRow extends QueryResultRow {
  token: string;
  platform: DevicePlatform;
  created_at: Date;
  last_seen_at: Date;
}

const columns = "token, platform, created_at, last_seen_at";

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be empty.`);
  return normalized;
}

function requirePlatform(platform: DevicePlatform): DevicePlatform {
  if (!(devicePlatforms as readonly string[]).includes(platform)) {
    throw new Error(`platform must be one of: ${devicePlatforms.join(", ")}.`);
  }
  return platform;
}

function toDeviceToken(row: DeviceTokenRow): DeviceToken {
  return { token: row.token, platform: row.platform, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
}

async function withPool<T>(options: DatabaseOptions, operation: (pool: Pool) => Promise<T>): Promise<T> {
  if (options.connectionString.trim().length === 0) throw new Error("Database connectionString must not be empty.");
  const pool = new Pool({ connectionString: options.connectionString, ...defaultPoolConfig, ...options.poolConfig });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

/** Register once or refresh a returning device without changing its creation time. */
export async function registerDeviceToken(options: DatabaseOptions, input: RegisterDeviceTokenInput): Promise<DeviceToken> {
  const token = requireNonEmpty(input.token, "token");
  const platform = requirePlatform(input.platform);
  return withPool(options, async (pool) => {
    const result = await pool.query<DeviceTokenRow>(
      `INSERT INTO device_tokens (token, platform)
       VALUES ($1, $2)
       ON CONFLICT (token) DO UPDATE SET platform = EXCLUDED.platform, last_seen_at = now()
       RETURNING ${columns}`,
      [token, platform],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("registerDeviceToken did not return a persisted row.");
    return toDeviceToken(row);
  });
}

export async function listDeviceTokens(options: DatabaseOptions): Promise<DeviceToken[]> {
  return withPool(options, async (pool) => {
    const result = await pool.query<DeviceTokenRow>(`SELECT ${columns} FROM device_tokens ORDER BY created_at ASC`);
    return result.rows.map(toDeviceToken);
  });
}

/** Remove only a token reported permanently invalid by the push provider. */
export async function removeDeviceToken(options: DatabaseOptions, token: string): Promise<void> {
  const normalizedToken = requireNonEmpty(token, "token");
  await withPool(options, async (pool) => {
    await pool.query("DELETE FROM device_tokens WHERE token = $1", [normalizedToken]);
  });
}
