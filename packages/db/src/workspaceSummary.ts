import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";
import type { RunStatus } from "./runs.js";

export interface WorkspaceSummary {
  threadId: string;
  latestRun: { runId: string; status: RunStatus } | null;
  pendingApprovals: number;
  lastActivityAt: Date;
  /** TASK-304 / spec §3.3: blocked work items when the thread is a project's; else empty. */
  blockedTasks: BlockedTaskSummary[];
}

export interface BlockedTaskSummary {
  taskId: string;
  title: string;
  blockedReason: string;
  ownerRoleId: string | null;
}

interface WorkspaceSummaryRow extends QueryResultRow {
  thread_id: string;
  run_id: string | null;
  run_status: RunStatus | null;
  pending_approvals: string;
  last_activity_at: Date;
  blocked_tasks: Array<{ taskId: string; title: string; blockedReason: string; ownerRoleId: string | null }>;
}

function requireTenantId(tenantId: string): string {
  const normalized = tenantId.trim();
  if (normalized.length === 0) throw new Error("tenantId must not be empty.");
  return normalized;
}

/**
 * One bounded, tenant-owned row per workspace. The ownership predicates mirror
 * control-api's findTenantOwnedThread: a 1:1 thread needs its role owned by
 * the principal; every member of a group thread must be owned by it.
 */
export async function listWorkspaceSummary(options: DatabaseOptions, tenantId: string): Promise<WorkspaceSummary[]> {
  const ownerTenantId = requireTenantId(tenantId);
  return withPool(options, async (pool) => {
    const result = await pool.query<WorkspaceSummaryRow>(
      `SELECT threads.id AS thread_id,
              latest.run_id,
              latest.status AS run_status,
              (SELECT count(*)
                 FROM approvals
                WHERE approvals.run_id = latest.run_id
                  AND approvals.status = 'pending') AS pending_approvals,
              threads.updated_at AS last_activity_at,
              COALESCE((SELECT json_agg(json_build_object(
                          'taskId', pt.task_id, 'title', pt.title,
                          'blockedReason', pt.blocked_reason, 'ownerRoleId', pt.owner_role_id)
                          ORDER BY pt.updated_at, pt.task_id)
                          FROM projects pr
                          JOIN project_tasks pt ON pt.project_id = pr.project_id
                         WHERE pr.thread_id = threads.id AND pr.tenant_id = $1 AND pt.state = 'blocked'),
                       '[]'::json) AS blocked_tasks
         FROM threads
         LEFT JOIN LATERAL (
           SELECT messages.run_id, runs.status
             FROM messages
             JOIN runs ON runs.run_id = messages.run_id
            WHERE messages.thread_id = threads.id
              AND messages.run_id IS NOT NULL
            ORDER BY messages.created_at DESC, messages.id DESC
            LIMIT 1
         ) AS latest ON true
        WHERE (threads.role_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM roles
                  WHERE roles.role_id = threads.role_id
                    AND roles.tenant_id = $1
                    AND roles.status = 'active'
              ))
           OR (threads.role_id IS NULL AND NOT EXISTS (
                 SELECT 1
                   FROM thread_members
                   LEFT JOIN roles ON roles.role_id = thread_members.role_id
                  WHERE thread_members.thread_id = threads.id
                    AND (roles.tenant_id IS DISTINCT FROM $1 OR roles.status IS DISTINCT FROM 'active')
              ))
        ORDER BY threads.updated_at DESC, threads.id DESC`,
      [ownerTenantId],
    );
    return result.rows.map((row) => ({
      threadId: row.thread_id,
      latestRun: row.run_id === null || row.run_status === null ? null : { runId: row.run_id, status: row.run_status },
      pendingApprovals: Number(row.pending_approvals),
      lastActivityAt: row.last_activity_at,
      blockedTasks: row.blocked_tasks,
    }));
  });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  describe("listWorkspaceSummary input validation", () => {
    it("rejects a blank tenant before opening a pool", async () => {
      await expect(listWorkspaceSummary({ connectionString: "postgres://x" }, " ")).rejects.toThrow(/tenantId/);
    });
  });
}
