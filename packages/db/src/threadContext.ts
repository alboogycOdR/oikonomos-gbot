import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

/**
 * TASK-179 (G-03a) — per-thread context meter, rolling compaction summaries,
 * and the 'start fresh' epoch counter. Addendum F §3.3: this is THREAD
 * state, never memory — nothing in this module reads or writes any
 * `packages/memory` table.
 *
 * NOTE: not yet re-exported from `./index.ts` — that file is outside this
 * task's Owned_Paths (see contextCompaction.ts's module doc and this
 * task's dossier for the follow-up wiring task this implies).
 */

export interface ThreadContext {
  threadId: string;
  contextTokens: number;
  contextLimit: number;
  compactedThroughMessageId: string | null;
  epoch: number;
  updatedAt: Date;
}

export interface ThreadSummary {
  summaryId: string;
  threadId: string;
  epoch: number;
  coversThroughMessageId: string;
  body: string;
  createdAt: Date;
}

interface ThreadContextRow extends QueryResultRow {
  thread_id: string;
  context_tokens: number;
  context_limit: number;
  compacted_through_message_id: string | null;
  epoch: number;
  updated_at: Date;
}

interface ThreadSummaryRow extends QueryResultRow {
  summary_id: string;
  thread_id: string;
  epoch: number;
  covers_through_message_id: string;
  body: string;
  created_at: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CONTEXT_LIMIT = 8000;

const threadContextColumns =
  "thread_id, context_tokens, context_limit, compacted_through_message_id, epoch, updated_at";
const threadSummaryColumns = "summary_id, thread_id, epoch, covers_through_message_id, body, created_at";

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be empty.`);
  return trimmed;
}

function requireUuid(value: string, field: string): string {
  const trimmed = requireNonEmpty(value, field);
  if (!UUID_RE.test(trimmed)) throw new Error(`${field} must be a UUID.`);
  return trimmed;
}

function toThreadContext(row: ThreadContextRow): ThreadContext {
  return {
    threadId: row.thread_id,
    contextTokens: row.context_tokens,
    contextLimit: row.context_limit,
    compactedThroughMessageId: row.compacted_through_message_id,
    epoch: row.epoch,
    updatedAt: row.updated_at,
  };
}

function toThreadSummary(row: ThreadSummaryRow): ThreadSummary {
  return {
    summaryId: row.summary_id,
    threadId: row.thread_id,
    epoch: row.epoch,
    coversThroughMessageId: row.covers_through_message_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

async function withPool<T>(options: DatabaseOptions, fn: (pool: Pool) => Promise<T>): Promise<T> {
  if (options.connectionString.trim().length === 0) throw new Error("Database connectionString must not be empty.");
  const pool = new Pool({ connectionString: options.connectionString, ...defaultPoolConfig, ...options.poolConfig });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Row-per-thread lazily created on first read. A thread with no
 * `thread_context` row yet is indistinguishable from a fresh thread that
 * has never been measured — this returns the same defaults the migration's
 * column defaults declare (`context_limit` 8000, `epoch` 0), so callers
 * never have to special-case "no row yet" from "row with defaults".
 */
export async function getOrInitThreadContext(
  options: DatabaseOptions,
  threadId: string,
): Promise<ThreadContext> {
  const normalizedThreadId = requireUuid(threadId, "threadId");
  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadContextRow>(
      `INSERT INTO thread_context (thread_id, context_limit)
       VALUES ($1, $2)
       ON CONFLICT (thread_id) DO UPDATE SET thread_id = thread_context.thread_id
       RETURNING ${threadContextColumns}`,
      [normalizedThreadId, DEFAULT_CONTEXT_LIMIT],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("getOrInitThreadContext did not return a persisted row.");
    return toThreadContext(row);
  });
}

/**
 * Advances the meter and (when a compaction just ran) the compacted-through
 * cursor. `contextTokens` is always overwritten with the freshly measured
 * value (WBS AC: "asserted on the measured number, not inferred") —
 * never incremented, since it is a point-in-time estimate, not a counter.
 */
export async function updateThreadContext(
  options: DatabaseOptions,
  threadId: string,
  patch: { contextTokens: number; compactedThroughMessageId?: string },
): Promise<ThreadContext> {
  const normalizedThreadId = requireUuid(threadId, "threadId");
  if (!Number.isInteger(patch.contextTokens) || patch.contextTokens < 0) {
    throw new Error("contextTokens must be a non-negative integer.");
  }
  const compactedThroughMessageId =
    patch.compactedThroughMessageId === undefined
      ? null
      : requireUuid(patch.compactedThroughMessageId, "compactedThroughMessageId");

  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadContextRow>(
      `INSERT INTO thread_context (thread_id, context_tokens, compacted_through_message_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (thread_id) DO UPDATE SET
         context_tokens = EXCLUDED.context_tokens,
         compacted_through_message_id = COALESCE(EXCLUDED.compacted_through_message_id, thread_context.compacted_through_message_id),
         updated_at = now()
       RETURNING ${threadContextColumns}`,
      [normalizedThreadId, patch.contextTokens, compactedThroughMessageId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("updateThreadContext did not return a persisted row.");
    return toThreadContext(row);
  });
}

/**
 * 'Start fresh' (spec (4)): increments the epoch. Older turns and summaries
 * stay in the database (never deleted — still returned by
 * `GET /threads/:id/messages`), but a higher epoch means `promptAssembly`
 * never sees them again. Also resets the meter cursor, since a fresh epoch
 * starts with no verbatim history and no summary of its own yet.
 */
export async function startFreshEpoch(options: DatabaseOptions, threadId: string): Promise<ThreadContext> {
  const normalizedThreadId = requireUuid(threadId, "threadId");
  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadContextRow>(
      `INSERT INTO thread_context (thread_id, epoch)
       VALUES ($1, 1)
       ON CONFLICT (thread_id) DO UPDATE SET
         epoch = thread_context.epoch + 1,
         context_tokens = 0,
         compacted_through_message_id = NULL,
         updated_at = now()
       RETURNING ${threadContextColumns}`,
      [normalizedThreadId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("startFreshEpoch did not return a persisted row.");
    return toThreadContext(row);
  });
}

export async function insertThreadSummary(
  options: DatabaseOptions,
  input: { threadId: string; epoch: number; coversThroughMessageId: string; body: string },
): Promise<ThreadSummary> {
  const threadId = requireUuid(input.threadId, "threadId");
  const coversThroughMessageId = requireUuid(input.coversThroughMessageId, "coversThroughMessageId");
  if (!Number.isInteger(input.epoch) || input.epoch < 0) throw new Error("epoch must be a non-negative integer.");
  const body = requireNonEmpty(input.body, "body");

  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadSummaryRow>(
      `INSERT INTO thread_summaries (thread_id, epoch, covers_through_message_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING ${threadSummaryColumns}`,
      [threadId, input.epoch, coversThroughMessageId, body],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("insertThreadSummary did not return a persisted row.");
    return toThreadSummary(row);
  });
}

/** The most recent summary for `epoch`, or null when none has been produced yet. */
export async function getLatestThreadSummary(
  options: DatabaseOptions,
  threadId: string,
  epoch: number,
): Promise<ThreadSummary | null> {
  const normalizedThreadId = requireUuid(threadId, "threadId");
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error("epoch must be a non-negative integer.");

  return withPool(options, async (pool) => {
    const result = await pool.query<ThreadSummaryRow>(
      `SELECT ${threadSummaryColumns} FROM thread_summaries
       WHERE thread_id = $1 AND epoch = $2
       ORDER BY created_at DESC, summary_id DESC
       LIMIT 1`,
      [normalizedThreadId, epoch],
    );
    return result.rows[0] === undefined ? null : toThreadSummary(result.rows[0]);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/db threadContext — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };
    const live: DatabaseOptions = { connectionString: "postgres://x" };
    const threadId = "11111111-1111-1111-1111-111111111111";
    const messageId = "22222222-2222-2222-2222-222222222222";

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(getOrInitThreadContext(options, threadId)).rejects.toThrow(/connectionString/);
      await expect(updateThreadContext(options, threadId, { contextTokens: 1 })).rejects.toThrow(/connectionString/);
      await expect(startFreshEpoch(options, threadId)).rejects.toThrow(/connectionString/);
      await expect(
        insertThreadSummary(options, { threadId, epoch: 0, coversThroughMessageId: messageId, body: "x" }),
      ).rejects.toThrow(/connectionString/);
      await expect(getLatestThreadSummary(options, threadId, 0)).rejects.toThrow(/connectionString/);
    });

    it("rejects a non-UUID threadId", async () => {
      await expect(getOrInitThreadContext(live, "not-a-uuid")).rejects.toThrow(/threadId/);
      await expect(startFreshEpoch(live, "not-a-uuid")).rejects.toThrow(/threadId/);
    });

    it("rejects a negative or non-integer contextTokens", async () => {
      await expect(updateThreadContext(live, threadId, { contextTokens: -1 })).rejects.toThrow(/contextTokens/);
      await expect(updateThreadContext(live, threadId, { contextTokens: 1.5 })).rejects.toThrow(/contextTokens/);
    });

    it("rejects a non-UUID compactedThroughMessageId", async () => {
      await expect(
        updateThreadContext(live, threadId, { contextTokens: 1, compactedThroughMessageId: "bad" }),
      ).rejects.toThrow(/compactedThroughMessageId/);
    });

    it("rejects an invalid epoch or empty body on insertThreadSummary", async () => {
      await expect(
        insertThreadSummary(live, { threadId, epoch: -1, coversThroughMessageId: messageId, body: "x" }),
      ).rejects.toThrow(/epoch/);
      await expect(
        insertThreadSummary(live, { threadId, epoch: 0, coversThroughMessageId: messageId, body: "   " }),
      ).rejects.toThrow(/body/);
      await expect(
        insertThreadSummary(live, { threadId, epoch: 0, coversThroughMessageId: "bad", body: "x" }),
      ).rejects.toThrow(/coversThroughMessageId/);
    });

    it("rejects an invalid epoch on getLatestThreadSummary", async () => {
      await expect(getLatestThreadSummary(live, threadId, -1)).rejects.toThrow(/epoch/);
    });
  });
}
