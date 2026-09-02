import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

export interface NewThread {
  roleId: string;
  title?: string | null;
}

export interface Thread {
  id: string;
  roleId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ThreadRow extends QueryResultRow {
  id: string;
  role_id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

const threadColumns = "id, role_id, title, created_at, updated_at";

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    roleId: row.role_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function withPool<T>(options: DatabaseOptions, fn: (pool: Pool) => Promise<T>): Promise<T> {
  if (options.connectionString.trim().length === 0) {
    throw new Error("Database connectionString must not be empty.");
  }

  const pool = new Pool({ connectionString: options.connectionString, ...defaultPoolConfig, ...options.poolConfig });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function createThread(options: DatabaseOptions, input: NewThread): Promise<Thread> {
  const roleId = requireNonEmpty(input.roleId, "roleId");

  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadRow>(
      `INSERT INTO threads (role_id, title) VALUES ($1, $2)
       ON CONFLICT (role_id) DO UPDATE SET role_id = threads.role_id
       RETURNING ${threadColumns}`,
      [roleId, input.title ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("createThread did not return a persisted row.");
    return toThread(row);
  });
}

/** Lists all v1 bot conversations, most recently active first. */
export async function listThreads(options: DatabaseOptions): Promise<Thread[]> {
  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadRow>(
      `SELECT ${threadColumns} FROM threads ORDER BY updated_at DESC, id DESC`,
    );
    return result.rows.map(toThread);
  });
}

/** Returns the (at most one) v1 conversation for a bot role. */
export async function getThreadsForRole(options: DatabaseOptions, roleId: string): Promise<Thread[]> {
  const normalizedRoleId = requireNonEmpty(roleId, "roleId");
  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadRow>(
      `SELECT ${threadColumns} FROM threads WHERE role_id = $1 ORDER BY updated_at DESC, id DESC`,
      [normalizedRoleId],
    );
    return result.rows.map(toThread);
  });
}

/** Creates a v1 role conversation once, returning the existing row on repeat calls. */
export async function getOrCreateThreadForRole(
  options: DatabaseOptions,
  input: NewThread,
): Promise<Thread> {
  const roleId = requireNonEmpty(input.roleId, "roleId");
  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadRow>(
      `INSERT INTO threads (role_id, title) VALUES ($1, $2)
       ON CONFLICT (role_id) DO UPDATE SET role_id = threads.role_id
       RETURNING ${threadColumns}`,
      [roleId, input.title ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("getOrCreateThreadForRole did not return a persisted row.");
    return toThread(row);
  });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  describe("@oikonomos/db threads — input validation", () => {
    const live: DatabaseOptions = { connectionString: "postgres://x" };
    it("rejects an empty connection string and role id before opening a pool", async () => {
      await expect(createThread({ connectionString: " " }, { roleId: "role" })).rejects.toThrow(/connectionString/);
      await expect(createThread(live, { roleId: " " })).rejects.toThrow(/roleId/);
      await expect(getThreadsForRole(live, " ")).rejects.toThrow(/roleId/);
      await expect(getOrCreateThreadForRole(live, { roleId: " " })).rejects.toThrow(/roleId/);
    });
  });
}
