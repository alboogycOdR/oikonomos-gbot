import { createHash } from "node:crypto";

import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";

/** The closed set of typed mailbox handoffs (TASK-099 / OIK-102, TASK-299). */
export const handoffKinds = [
  "research.complete",
  "draft.ready_for_review",
  "task.assigned",
  "task.completed",
  "task.blocked",
  "status.requested",
] as const;
export type HandoffKind = (typeof handoffKinds)[number];
const projectHandoffKinds = new Set<HandoffKind>([
  "task.assigned",
  "task.completed",
  "task.blocked",
  "status.requested",
]);

/**
 * A locator for a live memory fact. Deliberately no `value` field: handoffs
 * point recipients to memory, which they re-read under their own identity.
 */
export interface MemoryHandoffFactReference {
  tenantId: string;
  scope: "agent" | "project" | "user";
  roleId?: string;
  projectId?: string;
  key: string;
}

/**
 * Locator for a Project board handoff. The snake_case field names are the
 * persisted wire format from ADR-019 §3; it deliberately contains neither a
 * fact value nor any authority-bearing data.
 */
export interface ProjectHandoffReference {
  project_id: string;
  task_id: string;
  artifact_ids: readonly string[];
}

export type HandoffFactReference = MemoryHandoffFactReference | ProjectHandoffReference;

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
  /** Worker-bound run that issued the handoff; never supplied by model input. */
  sourceRunId?: string;
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
  deliveryAttempts: number;
  lastDeliveryError: string | null;
  deliveryClaimedAt: Date | null;
  deliveryClaimToken: string | null;
  deliveryFailedAt: Date | null;
  /** The message was already persisted by this source run's identical send. */
  alreadySent?: boolean;
  hopDepth: number;
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
  delivery_attempts: number;
  last_delivery_error: string | null;
  delivery_claimed_at: Date | null;
  delivery_claim_token: string | null;
  delivery_failed_at: Date | null;
  hop_depth: number;
}

const messageColumns = `message_id, tenant_id, from_role_id, to_role_id, body,
       workspace_refs, handoff_kind, fact_ref, created_at, read_at,
       delivery_attempts, last_delivery_error, delivery_claimed_at, delivery_claim_token, delivery_failed_at, hop_depth`;

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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function handoffDedupeKey(input: { fromRoleId: string; toRoleId: string; body: string; handoffKind: HandoffKind | null; factRef: HandoffFactReference | null; sourceRunId: string }): string {
  return createHash("sha256").update(canonicalJson({
    fromRoleId: input.fromRoleId, toRoleId: input.toRoleId, handoffKind: input.handoffKind,
    body: input.body, factRef: input.factRef, sourceRunId: input.sourceRunId,
  })).digest("hex");
}

function handoffMaxDepth(): number {
  const configured = process.env.OIK_HANDOFF_MAX_DEPTH;
  if (configured === undefined || configured.trim() === "") return 4;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 4;
}

function validateMemoryFactRef(value: MemoryHandoffFactReference): MemoryHandoffFactReference {
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

function validateProjectHandoffRef(value: HandoffFactReference, handoffKind: HandoffKind): ProjectHandoffReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("project handoff factRef must be an object.");
  }
  const fields = Object.keys(value);
  const allowedFields = ["project_id", "task_id", "artifact_ids"];
  if (fields.length !== allowedFields.length || fields.some((field) => !allowedFields.includes(field))) {
    throw new Error("project handoff factRef must contain exactly project_id, task_id, artifact_ids.");
  }
  const ref = value as ProjectHandoffReference;
  const projectId = requireUuid(ref.project_id, "factRef.project_id");
  const taskId = requireUuid(ref.task_id, "factRef.task_id");
  if (!Array.isArray(ref.artifact_ids) || !ref.artifact_ids.every((artifactId) => typeof artifactId === "string")) {
    throw new Error("factRef.artifact_ids must be an array of UUIDs.");
  }
  const artifactIds = ref.artifact_ids.map((artifactId) => requireUuid(artifactId, "factRef.artifact_ids[]"));
  if (handoffKind === "task.completed" && artifactIds.length === 0) {
    throw new Error("task.completed requires at least one artifact ID.");
  }
  return { project_id: projectId, task_id: taskId, artifact_ids: artifactIds };
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
  if (projectHandoffKinds.has(input.handoffKind)) {
    return { handoffKind: input.handoffKind, factRef: validateProjectHandoffRef(input.factRef, input.handoffKind) };
  }
  return { handoffKind: input.handoffKind, factRef: validateMemoryFactRef(input.factRef as MemoryHandoffFactReference) };
}

async function validateProjectHandoff(
  pool: { query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) => Promise<{ rows: T[] }> },
  handoffKind: HandoffKind | null,
  factRef: HandoffFactReference | null,
  fromRoleId: string,
  toRoleId: string,
): Promise<void> {
  if (!projectHandoffKinds.has(handoffKind as HandoffKind) || factRef === null) return;
  const ref = factRef as ProjectHandoffReference;
  const task = await pool.query<{ task_id: string }>(
    `SELECT task_id FROM project_tasks WHERE project_id = $1::uuid AND task_id = $2::uuid`,
    [ref.project_id, ref.task_id],
  );
  if (task.rows.length !== 1) {
    throw new Error("project handoff task_id must reference a task in the same project.");
  }
  const members = await pool.query<{ sender_is_member: boolean; recipient_is_member: boolean }>(
    `SELECT bool_or(thread_members.role_id = $2) AS sender_is_member,
            bool_or(thread_members.role_id = $3) AS recipient_is_member
     FROM projects
     JOIN thread_members ON thread_members.thread_id = projects.thread_id
     WHERE projects.project_id = $1::uuid`,
    [ref.project_id, fromRoleId, toRoleId],
  );
  if (members.rows[0]?.sender_is_member !== true || members.rows[0]?.recipient_is_member !== true) {
    throw new Error("project handoff sender and recipient must both be project members.");
  }
  if (ref.artifact_ids.length === 0) return;
  const result = await pool.query<{ artifact_id: string }>(
    `SELECT artifact_id FROM project_artifacts
     WHERE project_id = $1::uuid AND artifact_id = ANY($2::uuid[])`,
    [ref.project_id, [...ref.artifact_ids]],
  );
  if (result.rows.length !== new Set(ref.artifact_ids).size) {
    throw new Error("project handoff artifact_ids must reference registered artifacts in the same project.");
  }
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
    deliveryAttempts: row.delivery_attempts,
    lastDeliveryError: row.last_delivery_error,
    deliveryClaimedAt: row.delivery_claimed_at,
    deliveryClaimToken: row.delivery_claim_token,
    deliveryFailedAt: row.delivery_failed_at,
    hopDepth: row.hop_depth,
  };
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
  const sourceRunId = input.sourceRunId === undefined ? undefined : requireUuid(input.sourceRunId, "sourceRunId");
  if (factRef !== null && !projectHandoffKinds.has(handoffKind as HandoffKind)
    && (factRef as MemoryHandoffFactReference).tenantId !== tenantId) {
    throw new Error("factRef.tenantId must match the handoff tenantId.");
  }

  return withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await validateProjectHandoff(client, handoffKind, factRef, fromRoleId, toRoleId);
      let hopDepth = 0;
      if (sourceRunId !== undefined) {
        const source = await client.query<{ hop_depth: number }>(
          `SELECT role_messages.hop_depth
           FROM runs JOIN tasks ON tasks.task_id = runs.task_id
           JOIN role_messages ON tasks.requested_by = CONCAT('role-message:', role_messages.message_id)
           WHERE runs.run_id = $1`, [sourceRunId],
        );
        hopDepth = (source.rows[0]?.hop_depth ?? -1) + 1;
      }
      if (hopDepth >= handoffMaxDepth()) {
        await client.query(`INSERT INTO audit_events (tenant_id, run_id, actor, event_type, payload)
          VALUES ($1, $2, $3, 'role_message.depth_capped', '{"category":"depth_capped"}'::jsonb)`, [tenantId, sourceRunId ?? null, `role:${fromRoleId}`]);
        await client.query("COMMIT");
        throw new Error(`Handoff depth cap reached (maximum ${handoffMaxDepth()}).`);
      }
      const dedupeKey = sourceRunId === undefined ? null : handoffDedupeKey({ fromRoleId, toRoleId, body, handoffKind, factRef, sourceRunId });
      const result = await client.query<RoleMessageRow>(
        `INSERT INTO role_messages (tenant_id, from_role_id, to_role_id, body, workspace_refs, handoff_kind, fact_ref, hop_depth, dedupe_key)
         VALUES (COALESCE($1, 'basileia'), $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING ${messageColumns}`,
        [input.tenantId ?? null, fromRoleId, toRoleId, body, JSON.stringify(workspaceRefs), handoffKind, factRef === null ? null : JSON.stringify(factRef), hopDepth, dedupeKey],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        await client.query("COMMIT");
        return toRoleMessage(row);
      }
      const existing = await client.query<RoleMessageRow>(`SELECT ${messageColumns} FROM role_messages WHERE dedupe_key = $1`, [dedupeKey]);
      const duplicate = existing.rows[0];
      if (duplicate === undefined) throw new Error("sendRoleMessage could not find the duplicate handoff.");
      await client.query(`INSERT INTO audit_events (tenant_id, run_id, actor, event_type, payload)
        VALUES ($1, $2, $3, 'role_message.duplicate', '{"category":"duplicate"}'::jsonb)`, [tenantId, sourceRunId, `role:${fromRoleId}`]);
      await client.query("COMMIT");
      return { ...toRoleMessage(duplicate), alreadySent: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

/** A lease is five minutes: long enough for a worker turn, finite after a crash. */
const deliveryLeaseSql = "now() - interval '5 minutes'";

/**
 * Atomically leases one pending handoff to a worker and counts that attempt.
 * A concurrent poll receives null rather than creating a second recipient run.
 */
export async function claimRoleMessageDelivery(
  options: DatabaseOptions,
  messageId: string,
): Promise<RoleMessage | null> {
  const normalizedMessageId = requireUuid(messageId, "messageId");
  return withPool(options, async (pool) => {
    const result = await pool.query<RoleMessageRow>(
      `UPDATE role_messages
       SET delivery_attempts = delivery_attempts + 1, delivery_claimed_at = now(), delivery_claim_token = gen_random_uuid()
       WHERE message_id = $1
         AND read_at IS NULL
         AND delivery_attempts < 5
         AND (delivery_claimed_at IS NULL OR delivery_claimed_at < ${deliveryLeaseSql})
       RETURNING ${messageColumns}`,
      [normalizedMessageId],
    );
    return result.rows[0] === undefined ? null : toRoleMessage(result.rows[0]);
  });
}

/** Completes a previously leased delivery without reopening an already terminal row. */
export async function completeRoleMessageDelivery(
  options: DatabaseOptions,
  messageId: string,
  claimToken: string,
): Promise<RoleMessage | null> {
  const normalizedMessageId = requireUuid(messageId, "messageId");
  const normalizedClaimToken = requireUuid(claimToken, "claimToken");
  return withPool(options, async (pool) => {
    const result = await pool.query<RoleMessageRow>(
      `UPDATE role_messages
       SET read_at = now(), delivery_claimed_at = NULL, delivery_claim_token = NULL, last_delivery_error = NULL
       WHERE message_id = $1 AND read_at IS NULL AND delivery_claim_token = $2
       RETURNING ${messageColumns}`,
      [normalizedMessageId, normalizedClaimToken],
    );
    return result.rows[0] === undefined ? null : toRoleMessage(result.rows[0]);
  });
}

export type RoleMessageDeliveryErrorCategory = "recipient_inactive" | "delivery_error";

/**
 * Releases a failed lease for retry, or makes it terminal at the fifth attempt.
 * Error categories are deliberately closed so exception text and secrets never persist.
 */
export async function failRoleMessageDelivery(
  options: DatabaseOptions,
  messageId: string,
  claimToken: string,
  category: RoleMessageDeliveryErrorCategory,
  terminal = false,
): Promise<RoleMessage | null> {
  const normalizedMessageId = requireUuid(messageId, "messageId");
  const normalizedClaimToken = requireUuid(claimToken, "claimToken");
  return withPool(options, async (pool) => {
    const result = await pool.query<RoleMessageRow>(
      `UPDATE role_messages
       SET last_delivery_error = $2,
           delivery_claimed_at = NULL,
           delivery_claim_token = NULL,
           read_at = CASE WHEN $3 OR delivery_attempts >= 5 THEN now() ELSE read_at END,
           delivery_failed_at = CASE WHEN $3 OR delivery_attempts >= 5 THEN now() ELSE delivery_failed_at END
       WHERE message_id = $1 AND read_at IS NULL AND delivery_claim_token = $4
       RETURNING ${messageColumns}`,
      [normalizedMessageId, category, terminal, normalizedClaimToken],
    );
    return result.rows[0] === undefined ? null : toRoleMessage(result.rows[0]);
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

    it("rejects project handoff values, missing fields, and extra fields before opening a pool", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      const base = {
        project_id: "11111111-1111-1111-1111-111111111111",
        task_id: "22222222-2222-2222-2222-222222222222",
        artifact_ids: [],
      };
      for (const factRef of [
        { ...base, value: "must never travel" },
        { project_id: base.project_id, task_id: base.task_id },
        { ...base, unexpected: true },
      ]) {
        await expect(sendRoleMessage(live, {
          fromRoleId: "a", toRoleId: "b", body: "hi", handoffKind: "task.assigned",
          factRef: factRef as unknown as HandoffFactReference,
        })).rejects.toThrow(/exactly project_id, task_id, artifact_ids/);
      }
      await expect(sendRoleMessage(live, {
        fromRoleId: "a", toRoleId: "b", body: "hi", handoffKind: "task.completed",
        factRef: base,
      })).rejects.toThrow(/at least one artifact/);
      await expect(sendRoleMessage(live, {
        fromRoleId: "a", toRoleId: "b", body: "hi", handoffKind: "task.blocked",
        factRef: { ...base, artifact_ids: ["not-a-uuid"] },
      })).rejects.toThrow(/artifact_ids\[\].*UUID/);
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
