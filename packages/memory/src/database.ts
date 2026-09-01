import { Pool, type PoolConfig } from "pg";

/**
 * TASK-085 / Addendum F §3.3 (F6) — local pool helper for the memory store.
 *
 * `packages/memory` is a separate workspace package from `packages/db`
 * (Owned_Paths keeps them disjoint this wave), so this file intentionally
 * duplicates the small pool-config shape `packages/db/src/database.ts`
 * already uses rather than reaching across package boundaries.
 */
export const defaultPoolConfig: Pick<
  PoolConfig,
  "max" | "idleTimeoutMillis" | "connectionTimeoutMillis" | "maxUses"
> = {
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  maxUses: 7_500,
};

export interface DatabaseOptions {
  connectionString: string;
  poolConfig?: Partial<typeof defaultPoolConfig>;
}

export async function withPool<T>(
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

export function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}
