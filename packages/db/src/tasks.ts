import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

/**
 * TASK-061 / Synthesis §5.1 — task lifecycle status enum, already defined
 * in `infra/postgres/migrations/001_schema_v1.up.sql` as `task_status`.
 * This module maps to it verbatim and must never introduce a value the
 * enum doesn't have.
 */
export const taskStatuses = [
  "draft",
  "queued",
  "running",
  "waiting_approval",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export interface NewTask {
  tenantId?: string;
  roleId: string;
  title: string;
  goal: string;
  routineId?: string | null;
  requestedBy: string;
}

export interface Task {
  taskId: string;
  tenantId: string;
  roleId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  routineId: string | null;
  requestedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TaskRow extends QueryResultRow {
  task_id: string;
  tenant_id: string;
  role_id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  routine_id: string | null;
  requested_by: string;
  created_at: Date;
  updated_at: Date;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const taskColumns = `task_id, tenant_id, role_id, title, goal, status,
       routine_id, requested_by, created_at, updated_at`;

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function requireUuid(value: string, field: string): string {
  const trimmed = requireNonEmpty(value, field);
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`${field} must be a UUID.`);
  }
  return trimmed;
}

/**
 * `TaskStatus` is a TS-level guarantee only — a caller building
 * `TaskListFilter` from an untyped source (an HTTP query string, a JSON
 * body) can hand `listTasks` any string. Left unchecked, an invalid value
 * either surfaces as a raw Postgres enum-cast error or, if the parameter
 * inference ever changes, silently matches nothing. Reject it here with a
 * clear message instead (review round 1, non-blocking finding).
 */
function requireTaskStatus(value: TaskStatus, field: string): TaskStatus {
  if (!taskStatuses.includes(value)) {
    throw new Error(`${field} must be one of: ${taskStatuses.join(", ")}.`);
  }
  return value;
}

function toTask(row: TaskRow): Task {
  return {
    taskId: row.task_id,
    tenantId: row.tenant_id,
    roleId: row.role_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    routineId: row.routine_id,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

/**
 * Create a task. Status is always the table default (`draft`).
 */
export async function createTask(
  options: DatabaseOptions,
  input: NewTask,
): Promise<Task> {
  const roleId = requireNonEmpty(input.roleId, "roleId");
  const title = requireNonEmpty(input.title, "title");
  const goal = requireNonEmpty(input.goal, "goal");
  const requestedBy = requireNonEmpty(input.requestedBy, "requestedBy");
  const routineId =
    input.routineId === undefined || input.routineId === null
      ? null
      : requireUuid(input.routineId, "routineId");

  return withPool(options, async (pool) => {
    const result = await pool.query<TaskRow>(
      `INSERT INTO tasks (tenant_id, role_id, title, goal, routine_id, requested_by)
       VALUES (COALESCE($1, 'basileia'), $2, $3, $4, $5, $6)
       RETURNING ${taskColumns}`,
      [input.tenantId ?? null, roleId, title, goal, routineId, requestedBy],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createTask did not return a persisted row.");
    }
    return toTask(row);
  });
}

export async function getTask(
  options: DatabaseOptions,
  taskId: string,
): Promise<Task | null> {
  const normalizedTaskId = requireUuid(taskId, "taskId");

  return withPool(options, async (pool) => {
    const result = await pool.query<TaskRow>(
      `SELECT ${taskColumns}
       FROM tasks
       WHERE task_id = $1`,
      [normalizedTaskId],
    );
    return result.rows[0] === undefined ? null : toTask(result.rows[0]);
  });
}

export interface TaskListFilter {
  tenantId?: string;
  status?: TaskStatus;
  /** Return only tasks created by this persisted routine. */
  routineId?: string;
  limit?: number;
  /** Opaque page token from a previous `listTasks` call's `nextCursor`. */
  cursor?: string;
}

export interface TaskListPage {
  tasks: Task[];
  nextCursor: string | null;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

interface TaskCursor {
  createdAt: string;
  taskId: string;
}

/**
 * Row shape returned by the `listTasks` query specifically: it adds
 * `created_at_cursor`, a server-side `::text` cast of `created_at`, used
 * ONLY to build the pagination cursor.
 *
 * `created_at` (the `TaskRow` field, parsed to a JS `Date` by `pg`) is
 * millisecond-precision, while Postgres's `timestamptz` column is
 * microsecond-precision. `row.created_at.toISOString()` therefore silently
 * truncates the cursor's timestamp down to the millisecond, which can make
 * it strictly EARLIER than the true boundary row's timestamp whenever that
 * row has a non-zero microsecond remainder (the common case) — the next
 * page's `(created_at, task_id) < (cursor.createdAt, cursor.taskId)` filter
 * then silently EXCLUDES that boundary row, and any other row sharing its
 * millisecond bucket, from every subsequent page. `created_at::text` is
 * Postgres's own lossless textual representation, so casting it back with
 * `::timestamptz` on the next query round-trips exactly.
 */
interface TaskListRow extends TaskRow {
  created_at_cursor: string;
}

function encodeTaskCursor(row: Pick<TaskListRow, "created_at_cursor" | "task_id">): string {
  const payload: TaskCursor = {
    createdAt: row.created_at_cursor,
    taskId: row.task_id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeTaskCursor(cursor: string): TaskCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is not a valid listTasks cursor.");
  }
  const candidate = parsed as Partial<TaskCursor> | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.taskId !== "string"
  ) {
    throw new Error("cursor is not a valid listTasks cursor.");
  }
  return { createdAt: candidate.createdAt, taskId: candidate.taskId };
}

/**
 * Newest-first, keyset-paginated task listing. Ordering is
 * `(created_at DESC, task_id DESC)` so pagination stays stable and
 * duplicate-free even when two tasks share a `created_at` timestamp.
 */
export async function listTasks(
  options: DatabaseOptions,
  filter: TaskListFilter = {},
): Promise<TaskListPage> {
  const limit =
    filter.limit === undefined
      ? DEFAULT_LIST_LIMIT
      : Math.min(Math.max(1, Math.trunc(filter.limit)), MAX_LIST_LIMIT);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.tenantId !== undefined) {
    params.push(requireNonEmpty(filter.tenantId, "tenantId"));
    conditions.push(`tenant_id = $${params.length}`);
  }
  if (filter.status !== undefined) {
    params.push(requireTaskStatus(filter.status, "status"));
    conditions.push(`status = $${params.length}`);
  }
  if (filter.routineId !== undefined) {
    params.push(requireUuid(filter.routineId, "routineId"));
    conditions.push(`routine_id = $${params.length}`);
  }
  if (filter.cursor !== undefined) {
    const cursor = decodeTaskCursor(filter.cursor);
    params.push(cursor.createdAt, requireUuid(cursor.taskId, "cursor.taskId"));
    conditions.push(
      `(created_at, task_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit + 1);

  return withPool(options, async (pool) => {
    const result = await pool.query<TaskListRow>(
      `SELECT ${taskColumns}, created_at::text AS created_at_cursor
       FROM tasks
       ${where}
       ORDER BY created_at DESC, task_id DESC
       LIMIT $${params.length}`,
      params,
    );

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const lastRow = rows[rows.length - 1];
    const nextCursor = hasMore && lastRow !== undefined ? encodeTaskCursor(lastRow) : null;

    return { tasks: rows.map(toTask), nextCursor };
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/db tasks — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        createTask(options, {
          roleId: "inbox-triage",
          title: "t",
          goal: "g",
          requestedBy: "alister",
        }),
      ).rejects.toThrow(/connectionString/);
      await expect(
        getTask(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
      await expect(listTasks(options)).rejects.toThrow(/connectionString/);
    });

    it("rejects a non-UUID taskId on getTask", async () => {
      await expect(
        getTask({ connectionString: "postgres://x" }, "not-a-uuid"),
      ).rejects.toThrow(/UUID/);
    });

    it("rejects a status filter on listTasks that is not in taskStatuses", async () => {
      await expect(
        listTasks(
          { connectionString: "postgres://x" },
          { status: "not-a-status" as TaskStatus },
        ),
      ).rejects.toThrow(/status/);
    });

    it("rejects empty roleId/title/goal/requestedBy on createTask", async () => {
      await expect(
        createTask(
          { connectionString: "postgres://x" },
          { roleId: "   ", title: "t", goal: "g", requestedBy: "alister" },
        ),
      ).rejects.toThrow(/roleId/);
      await expect(
        createTask(
          { connectionString: "postgres://x" },
          { roleId: "inbox-triage", title: "   ", goal: "g", requestedBy: "alister" },
        ),
      ).rejects.toThrow(/title/);
      await expect(
        createTask(
          { connectionString: "postgres://x" },
          { roleId: "inbox-triage", title: "t", goal: "   ", requestedBy: "alister" },
        ),
      ).rejects.toThrow(/goal/);
      await expect(
        createTask(
          { connectionString: "postgres://x" },
          { roleId: "inbox-triage", title: "t", goal: "g", requestedBy: "   " },
        ),
      ).rejects.toThrow(/requestedBy/);
    });

    it("rejects an invalid cursor on listTasks", async () => {
      await expect(
        listTasks({ connectionString: "postgres://x" }, { cursor: "not-base64json" }),
      ).rejects.toThrow(/cursor/);
    });

    it("clamps limit into [1, MAX_LIST_LIMIT] rather than trusting the caller", async () => {
      // This is exercised against a live DB in the integration suite; here we
      // only assert the function does not throw for out-of-range values before
      // it ever reaches a pool.
      await expect(
        listTasks({ connectionString: "   " }, { limit: -5 }),
      ).rejects.toThrow(/connectionString/);
      await expect(
        listTasks({ connectionString: "   " }, { limit: 100000 }),
      ).rejects.toThrow(/connectionString/);
    });
  });
}
