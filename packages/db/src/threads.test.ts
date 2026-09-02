import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRole,
  createThread,
  defaultPoolConfig,
  getOrCreateThreadForRole,
  getThreadsForRole,
  listThreads,
} from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const migrationDirectory = fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url));

integration("packages/db threads — migration + CRUD (TASK-105)", () => {
  let pool: Pool;
  const tenantId = "task-105-threads-suite";
  const roleId = "task-105-threads-suite-role";

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    const up = await readFile(`${migrationDirectory}008_threads_messages.up.sql`, "utf8");
    await pool.query(up);
    await cleanup();
    await createRole(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Threads Suite", title: "Threads Suite Role" },
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("creates exactly the specified tables, FKs, role check, and polling index", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('threads', 'messages')
       ORDER BY table_name, ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { table_name: "messages", column_name: "id", is_nullable: "NO" },
      { table_name: "messages", column_name: "thread_id", is_nullable: "NO" },
      { table_name: "messages", column_name: "role", is_nullable: "NO" },
      { table_name: "messages", column_name: "body", is_nullable: "NO" },
      { table_name: "messages", column_name: "run_id", is_nullable: "YES" },
      { table_name: "messages", column_name: "created_at", is_nullable: "NO" },
      { table_name: "threads", column_name: "id", is_nullable: "NO" },
      { table_name: "threads", column_name: "role_id", is_nullable: "NO" },
      { table_name: "threads", column_name: "title", is_nullable: "YES" },
      { table_name: "threads", column_name: "created_at", is_nullable: "NO" },
      { table_name: "threads", column_name: "updated_at", is_nullable: "NO" },
    ]);

    const constraints = await pool.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid IN ('threads'::regclass, 'messages'::regclass) ORDER BY conname`,
    );
    expect(constraints.rows.some((row) => /FOREIGN KEY \(role_id\).*REFERENCES roles\(role_id\)/.test(row.definition))).toBe(true);
    expect(constraints.rows.some((row) => /FOREIGN KEY \(thread_id\).*REFERENCES threads\(id\)/.test(row.definition))).toBe(true);
    expect(constraints.rows.some((row) => /FOREIGN KEY \(run_id\).*REFERENCES runs\(run_id\)/.test(row.definition))).toBe(true);
    expect(constraints.rows.some((row) => /CHECK \(\(role = ANY \(ARRAY\['user'::text, 'bot'::text, 'system'::text\]\)\)\)/.test(row.definition))).toBe(true);

    const index = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'messages_thread_id_created_at_idx'",
    );
    expect(index.rows[0]?.indexdef).toMatch(/\(thread_id, created_at\)/);
  });

  it("creates and lists a thread", async () => {
    const created = await createThread({ connectionString: connectionString! }, { roleId, title: "A thread" });
    const repeated = await createThread({ connectionString: connectionString! }, { roleId, title: "ignored" });
    expect(created.roleId).toBe(roleId);
    expect(created.title).toBe("A thread");
    expect(repeated).toEqual(created);
    expect(await getThreadsForRole({ connectionString: connectionString! }, roleId)).toEqual([created]);
    expect((await listThreads({ connectionString: connectionString! })).map((thread) => thread.id)).toContain(created.id);
  });

  it("getOrCreateThreadForRole is idempotent for a role", async () => {
    const first = await getOrCreateThreadForRole({ connectionString: connectionString! }, { roleId });
    const second = await getOrCreateThreadForRole({ connectionString: connectionString! }, { roleId, title: "ignored" });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe(first.title);
  });

  const roundTrip = process.env.MIGRATION_ROUND_TRIP === "1" ? it : it.skip;
  roundTrip("migration down removes both tables", async () => {
    const down = await readFile(`${migrationDirectory}008_threads_messages.down.sql`, "utf8");
    await pool.query(down);
    const absent = await pool.query("SELECT to_regclass('public.threads') AS threads, to_regclass('public.messages') AS messages");
    expect(absent.rows[0]).toEqual({ threads: null, messages: null });

    const up = await readFile(`${migrationDirectory}008_threads_messages.up.sql`, "utf8");
    await pool.query(up);
    await createRole(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Threads Suite", title: "Threads Suite Role" },
    );
  });
});
