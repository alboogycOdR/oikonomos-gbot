import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

/** The closed set of typed mailbox handoffs (TASK-099 / OIK-102). */
export const handoffKinds = ["research.complete", "draft.ready_for_review"] as const;
export type HandoffKind = (typeof handoffKinds)[number];

/**
 * A locator for a live memory fact. Deliberately no `value` field: handoffs
 * point recipients to memory, which they re-read under their own identity.
 */
export interface HandoffFactReference {
  tenantId: string;
  scope: "agent" | "project" | "user";
  roleId?: string;
  projectId?: string;
  key: string;
}

/**
 * TASK-084 / Addendum F §3.5 (F8) — async role-to-role handoff. A handoff
 * carries no privilege (R13): the receiving role acts under its own
 * grants, never the sender's — that invariant is enforced by the caller
 * (the `send_to_role` tool / broker), not by this data-access module, but
 * this module never returns anything that could be mistaken for a grant.
 * No file bytes travel; `workspaceRefs` carries paths only.
 */
export interface NewRoleMessage {
  tenantId?: string;
  fromRoleId: string;
  toRoleId: string;
  body: string;
  workspaceRefs?: readonly string[];
  handoffKind?: HandoffKind;
  factRef?: HandoffFactReference;
}

export interface RoleMessage {
  messageId: string;
  tenantId: string;
  fromRoleId: string;
  toRoleId: string;
  body: string;
  workspaceRefs: readonly string[];
  handoffKind: HandoffKind | null;
  factRef: HandoffFactReference | null;
  createdAt: Date;
  readAt: Date | null;
}

interface RoleMessageRow extends QueryResultRow {
  message_id: string;
  tenant_id: string;
  from_role_id: string;
  to_role_id: string;
  body: string;
  workspace_refs: string[];
  handoff_kind: HandoffKind | null;
  fact_ref: HandoffFactReference | null;
  created_at: Date;
  read_at: Date | null;
}

const messageColumns = `message_id, tenant_id, from_role_id, to_role_id, body,
       workspace_refs, handoff_kind, fact_ref, created_at, read_at`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function validateFactRef(value: HandoffFactReference): HandoffFactReference {
  const tenantId = requireNonEmpty(value.tenantId, "factRef.tenantId");
  const key = requireNonEmpty(value.key, "factRef.key");
  if (!["agent", "project", "user"].includes(value.scope)) {
    throw new Error("factRef.scope must be one of: agent, project, user.");
  }
  const roleId = value.roleId === undefined ? undefined : requireNonEmpty(value.roleId, "factRef.roleId");
  const projectId = value.projectId === undefined
    ? undefined
    : requireNonEmpty(value.projectId, "factRef.projectId");
  if (value.scope === "agent" && (roleId === undefined || projectId !== undefined)) {
    throw new Error("factRef for scope='agent' requires roleId and forbids projectId.");
  }
  if (value.scope === "project" && (projectId === undefined || roleId !== undefined)) {
    throw new Error("factRef for scope='project' requires projectId and forbids roleId.");
  }
  if (value.scope === "user" && (roleId !== undefined || projectId !== undefined)) {
    throw new Error("factRef for scope='user' forbids roleId and projectId.");
  }
  return { tenantId, scope: value.scope, ...(roleId === undefined ? {} : { roleId }), ...(projectId === undefined ? {} : { projectId }), key };
}

function validateTypedHandoff(input: NewRoleMessage): {
  handoffKind: HandoffKind | null;
  factRef: HandoffFactReference | null;
} {
  if ((input.handoffKind === undefined) !== (input.factRef === undefined)) {
    throw new Error("handoffKind and factRef must be supplied together.");
  }
  if (input.handoffKind === undefined || input.factRef === undefined) {
    return { handoffKind: null, factRef: null };
  }
  if (!handoffKinds.includes(input.handoffKind)) {
    throw new Error(`handoffKind must be one of: ${handoffKinds.join(", ")}.`);
  }
  return { handoffKind: input.handoffKind, factRef: validateFactRef(input.factRef) };
}

function toRoleMessage(row: RoleMessageRow): RoleMessage {
  return {
    messageId: row.message_id,
    tenantId: row.tenant_id,
    fromRoleId: row.from_role_id,
    toRoleId: row.to_role_id,
    body: row.body,
    workspaceRefs: row.workspace_refs,
    handoffKind: row.handoff_kind,
    factRef: row.fact_ref,
    createdAt: row.created_at,
    readAt: row.read_at,
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
 * Send a handoff. Always async (F8 #1): this returns the persisted message
 * row as the sender's acknowledgement — never anything from the receiver's
 * side, since there is no same-turn reply to return.
 */
export async function sendRoleMessage(
  options: DatabaseOptions,
  input: NewRoleMessage,
): Promise<RoleMessage> {
  const fromRoleId = requireNonEmpty(input.fromRoleId, "fromRoleId");
  const toRoleId = requireNonEmpty(input.toRoleId, "toRoleId");
  const body = requireNonEmpty(input.body, "body");
  const workspaceRefs = input.workspaceRefs ?? [];
  const { handoffKind, factRef } = validateTypedHandoff(input);
  const tenantId = input.tenantId ?? "basileia";
  if (factRef !== null && factRef.tenantId !== tenantId) {
    throw new Error("factRef.tenantId must match the handoff tenantId.");
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<RoleMessageRow>(
      `INSERT INTO role_messages (tenant_id, from_role_id, to_role_id, body, workspace_refs, handoff_kind, fact_ref)
       VALUES (COALESCE($1, 'basileia'), $2, $3, $4, $5::jsonb, $6, $7::jsonb)
       RETURNING ${messageColumns}`,
      [
        input.tenantId ?? null,
        fromRoleId,
        toRoleId,
        body,
        JSON.stringify(workspaceRefs),
        handoffKind,
        factRef === null ? null : JSON.stringify(factRef),
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("sendRoleMessage did not return a persisted row.");
    }
    return toRoleMessage(row);
  });
}

export async function getRoleMessage(
  options: DatabaseOptions,
  messageId: string,
): Promise<RoleMessage | null> {
  const normalizedMessageId = requireUuid(messageId, "messageId");

  return withPool(options, async (pool) => {
    const result = await pool.query<RoleMessageRow>(
      `SELECT ${messageColumns} FROM role_messages WHERE message_id = $1`,
      [normalizedMessageId],
    );
    return result.rows[0] === undefined ? null : toRoleMessage(result.rows[0]);
  });
}

export interface RoleMessageListFilter {
  tenantId: string;
  toRoleId?: string;
  fromRoleId?: string;
  unreadOnly?: boolean;
}

/**
 * List messages, newest-first. Callers passing `toRoleId` get exactly that
 * role's inbox — this is the query the receiving role's own read path uses,
 * and it is deliberately tenant-scoped like every other list in this task.
 */
export async function listRoleMessages(
  options: DatabaseOptions,
  filter: RoleMessageListFilter,
): Promise<RoleMessage[]> {
  const tenantId = requireNonEmpty(filter.tenantId, "tenantId");
  const conditions = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];

  if (filter.toRoleId !== undefined) {
    params.push(requireNonEmpty(filter.toRoleId, "toRoleId"));
    conditions.push(`to_role_id = $${params.length}`);
  }
  if (filter.fromRoleId !== undefined) {
    params.push(requireNonEmpty(filter.fromRoleId, "fromRoleId"));
    conditions.push(`from_role_id = $${params.length}`);
  }
  if (filter.unreadOnly === true) {
    conditions.push(`read_at IS NULL`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<RoleMessageRow>(
      `SELECT ${messageColumns} FROM role_messages
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, message_id DESC`,
      params,
    );
    return result.rows.map(toRoleMessage);
  });
}

/** Mark a message read. Idempotent: re-marking an already-read message is a no-op success. */
export async function markRoleMessageRead(
  options: DatabaseOptions,
  messageId: string,
): Promise<RoleMessage> {
  const normalizedMessageId = requireUuid(messageId, "messageId");

  return withPool(options, async (pool) => {
    const result = await pool.query<RoleMessageRow>(
      `UPDATE role_messages
       SET read_at = COALESCE(read_at, now())
       WHERE message_id = $1
       RETURNING ${messageColumns}`,
      [normalizedMessageId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`markRoleMessageRead: no role_messages row for messageId ${normalizedMessageId}.`);
    }
    return toRoleMessage(row);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/db roleMessages — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        sendRoleMessage(options, { fromRoleId: "a", toRoleId: "b", body: "hi" }),
      ).rejects.toThrow(/connectionString/);
      await expect(
        getRoleMessage(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
      await expect(listRoleMessages(options, { tenantId: "basileia" })).rejects.toThrow(
        /connectionString/,
      );
      await expect(
        markRoleMessageRead(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
    });

    it("rejects empty fromRoleId/toRoleId/body on sendRoleMessage", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        sendRoleMessage(live, { fromRoleId: "   ", toRoleId: "b", body: "hi" }),
      ).rejects.toThrow(/fromRoleId/);
      await expect(
        sendRoleMessage(live, { fromRoleId: "a", toRoleId: "   ", body: "hi" }),
      ).rejects.toThrow(/toRoleId/);
      await expect(
        sendRoleMessage(live, { fromRoleId: "a", toRoleId: "b", body: "   " }),
      ).rejects.toThrow(/body/);
    });

    it("rejects incomplete or malformed typed handoffs before opening a pool", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        sendRoleMessage(live, { fromRoleId: "a", toRoleId: "b", body: "hi", handoffKind: "research.complete" }),
      ).rejects.toThrow(/handoffKind and factRef/);
      await expect(
        sendRoleMessage(live, {
          fromRoleId: "a",
          toRoleId: "b",
          body: "hi",
          handoffKind: "research.complete",
          factRef: { tenantId: "t", scope: "project", key: "k" },
        }),
      ).rejects.toThrow(/projectId/);
      await expect(
        sendRoleMessage(live, {
          tenantId: "tenant-a",
          fromRoleId: "a",
          toRoleId: "b",
          body: "hi",
          handoffKind: "research.complete",
          factRef: { tenantId: "tenant-b", scope: "user", key: "k" },
        }),
      ).rejects.toThrow(/must match/);
    });

    it("rejects a non-UUID messageId", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(getRoleMessage(live, "not-a-uuid")).rejects.toThrow(/UUID/);
      await expect(markRoleMessageRead(live, "not-a-uuid")).rejects.toThrow(/UUID/);
    });

    it("rejects an empty tenantId on listRoleMessages", async () => {
      await expect(
        listRoleMessages({ connectionString: "postgres://x" }, { tenantId: "   " }),
      ).rejects.toThrow(/tenantId/);
    });
  });
}
