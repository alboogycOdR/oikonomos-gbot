import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";
import type { RoleStatus } from "./roles.js";

export const roleSandboxStates = ["Pending", "Running", "Pausing", "Paused", "Resuming", "Stopping", "Terminated", "Failed"] as const;
export type RoleSandboxState = (typeof roleSandboxStates)[number];

export interface RoleSandbox {
  readonly roleId: string;
  readonly sandboxId: string;
  readonly state: RoleSandboxState;
  /** Secret reference only; the resolved execd credential is never persisted. */
  readonly execdTokenRef: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
}

export interface UpsertRoleSandbox {
  readonly roleId: string;
  readonly sandboxId: string;
  readonly state: RoleSandboxState;
  readonly execdTokenRef: string;
}

/** A sandbox record together with the owning role data needed by maintenance sweeps. */
export interface RoleSandboxWithRole extends RoleSandbox {
  readonly tenantId: string;
  readonly roleStatus: RoleStatus;
}

interface RoleSandboxRow extends QueryResultRow {
  role_id: string;
  sandbox_id: string;
  state: RoleSandboxState;
  execd_token_ref: string;
  created_at: Date;
  last_used_at: Date;
}

interface RoleSandboxWithRoleRow extends RoleSandboxRow {
  tenant_id: string;
  role_status: RoleStatus;
}

const columns = "role_id, sandbox_id, state, execd_token_ref, created_at, last_used_at";

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be empty.`);
  return normalized;
}

function requireState(value: RoleSandboxState): RoleSandboxState {
  if (!roleSandboxStates.includes(value)) throw new Error(`state must be one of: ${roleSandboxStates.join(", ")}.`);
  return value;
}

function toRoleSandbox(row: RoleSandboxRow): RoleSandbox {
  return {
    roleId: row.role_id, sandboxId: row.sandbox_id, state: row.state,
    execdTokenRef: row.execd_token_ref, createdAt: row.created_at, lastUsedAt: row.last_used_at,
  };
}

function toRoleSandboxWithRole(row: RoleSandboxWithRoleRow): RoleSandboxWithRole {
  return { ...toRoleSandbox(row), tenantId: row.tenant_id, roleStatus: row.role_status };
}

export async function getRoleSandbox(options: DatabaseOptions, roleId: string): Promise<RoleSandbox | null> {
  const normalizedRoleId = requireText(roleId, "roleId");
  return withPool(options, async (pool) => {
    const result = await pool.query<RoleSandboxRow>(`SELECT ${columns} FROM role_sandboxes WHERE role_id = $1`, [normalizedRoleId]);
    return result.rows[0] === undefined ? null : toRoleSandbox(result.rows[0]);
  });
}

/**
 * Lists every persisted role office, including the owning role's tenant and
 * lifecycle status. This deliberately has no tenant filter: maintenance
 * reapers must cover offices for every tenant, not only the worker tenant.
 */
export async function listRoleSandboxes(options: DatabaseOptions): Promise<readonly RoleSandboxWithRole[]> {
  return withPool(options, async (pool) => {
    const result = await pool.query<RoleSandboxWithRoleRow>(
      `SELECT rs.role_id, rs.sandbox_id, rs.state, rs.execd_token_ref, rs.created_at, rs.last_used_at,
              r.tenant_id, r.status AS role_status
       FROM role_sandboxes rs
       INNER JOIN roles r ON r.role_id = rs.role_id
       ORDER BY r.tenant_id ASC, rs.role_id ASC`,
    );
    return result.rows.map(toRoleSandboxWithRole);
  });
}

/** Atomically records the current lifecycle state and refreshes last-use time. */
export async function upsertRoleSandbox(options: DatabaseOptions, input: UpsertRoleSandbox): Promise<RoleSandbox> {
  const roleId = requireText(input.roleId, "roleId");
  const sandboxId = requireText(input.sandboxId, "sandboxId");
  const execdTokenRef = requireText(input.execdTokenRef, "execdTokenRef");
  const state = requireState(input.state);
  return withPool(options, async (pool) => {
    const result = await pool.query<RoleSandboxRow>(
      `INSERT INTO role_sandboxes (role_id, sandbox_id, state, execd_token_ref)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (role_id) DO UPDATE SET sandbox_id = EXCLUDED.sandbox_id, state = EXCLUDED.state,
         execd_token_ref = EXCLUDED.execd_token_ref, last_used_at = now()
       RETURNING ${columns}`,
      [roleId, sandboxId, state, execdTokenRef],
    );
    if (result.rows[0] === undefined) throw new Error("upsertRoleSandbox did not return a row.");
    return toRoleSandbox(result.rows[0]);
  });
}

export async function updateRoleSandboxState(options: DatabaseOptions, roleId: string, state: RoleSandboxState): Promise<RoleSandbox | null> {
  const normalizedRoleId = requireText(roleId, "roleId");
  const normalizedState = requireState(state);
  return withPool(options, async (pool) => {
    const result = await pool.query<RoleSandboxRow>(
      `UPDATE role_sandboxes SET state = $2, last_used_at = now() WHERE role_id = $1 RETURNING ${columns}`,
      [normalizedRoleId, normalizedState],
    );
    return result.rows[0] === undefined ? null : toRoleSandbox(result.rows[0]);
  });
}
