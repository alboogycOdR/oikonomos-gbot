import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";

export const secretRequestStatuses = ["pending", "fulfilled", "declined"] as const;
export type SecretRequestStatus = (typeof secretRequestStatuses)[number];
export const SECRET_REQUEST_LABEL_MAX_CHARS = 200;
export const SECRET_REQUEST_PURPOSE_MAX_CHARS = 2_000;

export interface NewSecretRequest {
  tenantId: string;
  roleId: string;
  runId: string;
  label: string;
  purpose: string;
}

export interface SecretRequest {
  requestId: string;
  tenantId: string;
  roleId: string;
  runId: string;
  label: string;
  purpose: string;
  status: SecretRequestStatus;
  secretRef: string | null;
  createdAt: Date;
  fulfilledAt: Date | null;
}

interface SecretRequestRow extends QueryResultRow {
  request_id: string;
  tenant_id: string;
  role_id: string;
  run_id: string;
  label: string;
  purpose: string;
  status: SecretRequestStatus;
  secret_ref: string | null;
  created_at: Date;
  fulfilled_at: Date | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columns = "request_id, tenant_id, role_id, run_id, label, purpose, status, secret_ref, created_at, fulfilled_at";

function text(value: string, field: string, maximum?: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be empty.`);
  if (maximum !== undefined && trimmed.length > maximum) throw new Error(`${field} must be at most ${maximum} characters.`);
  return trimmed;
}

function uuid(value: string, field: string): string {
  const normalized = text(value, field);
  if (!UUID_RE.test(normalized)) throw new Error(`${field} must be a UUID.`);
  return normalized;
}

function toSecretRequest(row: SecretRequestRow): SecretRequest {
  return {
    requestId: row.request_id, tenantId: row.tenant_id, roleId: row.role_id, runId: row.run_id,
    label: row.label, purpose: row.purpose, status: row.status, secretRef: row.secret_ref,
    createdAt: row.created_at, fulfilledAt: row.fulfilled_at,
  };
}

export async function createSecretRequest(options: DatabaseOptions, input: NewSecretRequest): Promise<SecretRequest> {
  const tenantId = text(input.tenantId, "tenantId");
  const roleId = text(input.roleId, "roleId");
  const runId = uuid(input.runId, "runId");
  const label = text(input.label, "label", SECRET_REQUEST_LABEL_MAX_CHARS);
  const purpose = text(input.purpose, "purpose", SECRET_REQUEST_PURPOSE_MAX_CHARS);
  return withPool(options, async (pool) => {
    const result = await pool.query<SecretRequestRow>(
      `INSERT INTO secret_requests (tenant_id, role_id, run_id, label, purpose)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${columns}`,
      [tenantId, roleId, runId, label, purpose],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("createSecretRequest did not return a persisted row.");
    return toSecretRequest(row);
  });
}

/** Fulfilment receives only an opaque vault ref; plaintext is never accepted here. */
export async function fulfillSecretRequest(options: DatabaseOptions, requestId: string, secretRef: string): Promise<SecretRequest | null> {
  const normalizedRequestId = uuid(requestId, "requestId");
  const normalizedRef = text(secretRef, "secretRef");
  return withPool(options, async (pool) => {
    const result = await pool.query<SecretRequestRow>(
      `UPDATE secret_requests SET status = 'fulfilled', secret_ref = $2, fulfilled_at = now()
       WHERE request_id = $1 AND status = 'pending' RETURNING ${columns}`,
      [normalizedRequestId, normalizedRef],
    );
    return result.rows[0] === undefined ? null : toSecretRequest(result.rows[0]);
  });
}

export async function getSecretRequest(options: DatabaseOptions, requestId: string): Promise<SecretRequest | null> {
  const normalizedRequestId = uuid(requestId, "requestId");
  return withPool(options, async (pool) => {
    const result = await pool.query<SecretRequestRow>(`SELECT ${columns} FROM secret_requests WHERE request_id = $1`, [normalizedRequestId]);
    return result.rows[0] === undefined ? null : toSecretRequest(result.rows[0]);
  });
}
