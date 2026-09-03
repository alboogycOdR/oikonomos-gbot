import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

export interface NewThread {
  roleId: string;
  title?: string | null;
}

export interface Thread {
  // NOTE: the underlying `threads.role_id` column is nullable as of TASK-120's
  // migration (group threads leave it null, relying on thread_members
  // instead), but every accessor in *this* file only ever creates/returns
  // 1:1 threads with a real roleId — group-thread creation is TASK-121's own
  // new code path, which will need its own return type for that shape. Kept
  // as `string` here (rather than `string | null`) so this schema-only task
  // does not force a null-check ripple through today's 1:1-only control-api
  // callers for a case that cannot yet occur through this module's API.
  id: string;
  roleId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadMember {
  threadId: string;
  roleId: string;
  createdAt: Date;
}

interface ThreadRow extends QueryResultRow {
  id: string;
  role_id: string | null;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ThreadMemberRow extends QueryResultRow {
  thread_id: string;
  role_id: string;
  created_at: Date;
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
  if (row.role_id === null) {
    // Group threads (role_id IS NULL) are a TASK-121 creation path this
    // module's read functions don't yet need to represent — see the Thread
    // type's own comment. Fail loudly rather than silently coercing null to
    // a string if one is ever encountered through this module.
    throw new Error(`Thread ${row.id} has no role_id (group threads are not yet supported by this module).`);
  }
  return {
    id: row.id,
    roleId: row.role_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toThreadMember(row: ThreadMemberRow): ThreadMember {
  return { threadId: row.thread_id, roleId: row.role_id, createdAt: row.created_at };
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
       ON CONFLICT (role_id) WHERE role_id IS NOT NULL DO UPDATE SET role_id = threads.role_id
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
       ON CONFLICT (role_id) WHERE role_id IS NOT NULL DO UPDATE SET role_id = threads.role_id
       RETURNING ${threadColumns}`,
      [roleId, input.title ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("getOrCreateThreadForRole did not return a persisted row.");
    return toThread(row);
  });
}

/** Adds a bot to a thread's membership (group threads, TASK-121; idempotent). */
export async function addThreadMember(
  options: DatabaseOptions,
  input: { threadId: string; roleId: string },
): Promise<ThreadMember> {
  const threadId = requireNonEmpty(input.threadId, "threadId");
  const roleId = requireNonEmpty(input.roleId, "roleId");
  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadMemberRow>(
      `INSERT INTO thread_members (thread_id, role_id) VALUES ($1, $2)
       ON CONFLICT (thread_id, role_id) DO UPDATE SET role_id = thread_members.role_id
       RETURNING thread_id, role_id, created_at`,
      [threadId, roleId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("addThreadMember did not return a persisted row.");
    return toThreadMember(row);
  });
}

/** Lists every bot participating in a thread, oldest membership first. */
export async function listThreadMembers(options: DatabaseOptions, threadId: string): Promise<ThreadMember[]> {
  const normalizedThreadId = requireNonEmpty(threadId, "threadId");
  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadMemberRow>(
      `SELECT thread_id, role_id, created_at FROM thread_members WHERE thread_id = $1 ORDER BY created_at ASC, role_id ASC`,
      [normalizedThreadId],
    );
    return result.rows.map(toThreadMember);
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
      await expect(addThreadMember(live, { threadId: " ", roleId: "role" })).rejects.toThrow(/threadId/);
      await expect(addThreadMember(live, { threadId: "t", roleId: " " })).rejects.toThrow(/roleId/);
      await expect(listThreadMembers(live, " ")).rejects.toThrow(/threadId/);
    });
  });
}
