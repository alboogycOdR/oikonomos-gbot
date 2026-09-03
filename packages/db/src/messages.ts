import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

export const messageRoles = ["user", "bot", "system"] as const;
export type MessageRole = (typeof messageRoles)[number];

export interface NewMessage {
  threadId: string;
  role: MessageRole;
  body: string;
  runId?: string | null;
  senderRoleId?: string | null;
}

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  body: string;
  runId: string | null;
  // Optional (rather than `string | null`) so existing object literals built
  // before TASK-120 — e.g. control-api fixtures — remain valid without a
  // ripple edit outside this task's Owned_Paths; toMessage() below always
  // populates it (as null for pre-existing rows), so real values from the DB
  // are never actually missing this key.
  senderRoleId?: string | null;
  createdAt: Date;
}

export interface MessageListOptions {
  after?: string;
}

interface MessageRow extends QueryResultRow {
  id: string;
  thread_id: string;
  role: MessageRole;
  body: string;
  run_id: string | null;
  sender_role_id: string | null;
  created_at: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const messageColumns = "id, thread_id, role, body, run_id, sender_role_id, created_at";

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

function requireRole(value: MessageRole): MessageRole {
  if (!messageRoles.includes(value)) throw new Error(`role must be one of: ${messageRoles.join(", ")}.`);
  return value;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    body: row.body,
    runId: row.run_id,
    senderRoleId: row.sender_role_id,
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

export async function insertMessage(options: DatabaseOptions, input: NewMessage): Promise<Message> {
  const threadId = requireUuid(input.threadId, "threadId");
  const role = requireRole(input.role);
  const body = requireNonEmpty(input.body, "body");
  const runId = input.runId === undefined || input.runId === null ? null : requireUuid(input.runId, "runId");
  const senderRoleId =
    input.senderRoleId === undefined || input.senderRoleId === null
      ? null
      : requireNonEmpty(input.senderRoleId, "senderRoleId");

  return withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<MessageRow>(
        `INSERT INTO messages (thread_id, role, body, run_id, sender_role_id) VALUES ($1, $2, $3, $4, $5) RETURNING ${messageColumns}`,
        [threadId, role, body, runId, senderRoleId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("insertMessage did not return a persisted row.");
      await client.query("UPDATE threads SET updated_at = now() WHERE id = $1", [threadId]);
      await client.query("COMMIT");
      return toMessage(row);
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

/** Lists transcript messages oldest first; `after` is an exclusive message-id cursor. */
export async function listMessages(
  options: DatabaseOptions,
  threadId: string,
  listOptions: MessageListOptions = {},
): Promise<Message[]> {
  const normalizedThreadId = requireUuid(threadId, "threadId");
  const after = listOptions.after === undefined ? null : requireUuid(listOptions.after, "after");
  return withPool(options, async (pool) => {
    const result = await pool.query<MessageRow>(
      `SELECT ${messageColumns}
       FROM messages
       WHERE thread_id = $1
         AND ($2::uuid IS NULL OR (created_at, id) > (
           SELECT created_at, id FROM messages WHERE id = $2 AND thread_id = $1
         ))
       ORDER BY created_at ASC, id ASC`,
      [normalizedThreadId, after],
    );
    return result.rows.map(toMessage);
  });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  describe("@oikonomos/db messages — input validation", () => {
    const live: DatabaseOptions = { connectionString: "postgres://x" };
    const threadId = "11111111-1111-1111-1111-111111111111";
    it("rejects invalid inputs before opening a pool", async () => {
      await expect(insertMessage({ connectionString: " " }, { threadId, role: "user", body: "hi" })).rejects.toThrow(/connectionString/);
      await expect(insertMessage(live, { threadId: "invalid", role: "user", body: "hi" })).rejects.toThrow(/threadId/);
      await expect(insertMessage(live, { threadId, role: "other" as MessageRole, body: "hi" })).rejects.toThrow(/role/);
      await expect(insertMessage(live, { threadId, role: "user", body: " " })).rejects.toThrow(/body/);
      await expect(listMessages(live, threadId, { after: "invalid" })).rejects.toThrow(/after/);
      await expect(
        insertMessage(live, { threadId, role: "bot", body: "hi", senderRoleId: " " }),
      ).rejects.toThrow(/senderRoleId/);
    });
  });
}
