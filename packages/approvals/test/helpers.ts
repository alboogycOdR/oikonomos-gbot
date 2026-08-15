import { randomUUID } from "node:crypto";

import type { Approval, NewApproval } from "@oikonomos/db";
import type { ActionDigestInput } from "@oikonomos/shared";

import type { IssueApprovalRequest } from "../src/issue.js";
import { actionRender } from "../src/render.js";
import type { ApprovalStore, ConsumeApprovalResult } from "../src/store.js";

export const FIXTURE_RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

export function fixtureAction(
  overrides: Partial<ActionDigestInput> = {},
): ActionDigestInput {
  return {
    toolName: "mcp__gmail__create_draft",
    input: { to: "review@example.test", subject: "placeholder subject" },
    destination: "review@example.test",
    ...overrides,
  };
}

export function fixtureRequest(
  overrides: Partial<IssueApprovalRequest> = {},
): IssueApprovalRequest {
  return {
    runId: FIXTURE_RUN_ID,
    capabilityId: "email.create_draft",
    toolName: "mcp__gmail__create_draft",
    input: { to: "review@example.test", subject: "placeholder subject" },
    destination: "review@example.test",
    ...overrides,
  };
}

export function expectedRender(request: IssueApprovalRequest): string {
  return actionRender({
    toolName: request.toolName,
    input: request.input,
    destination: request.destination,
  });
}

export interface MemoryStore {
  readonly store: ApprovalStore;
  readonly rows: Map<string, Approval>;
  readonly events: string[];
}

export function createMemoryStore(): MemoryStore {
  const rows = new Map<string, Approval>();
  const events: string[] = [];

  const store: ApprovalStore = {
    async insert(approval: NewApproval): Promise<Approval> {
      events.push("persist");
      if (approval.nonce === undefined) {
        throw new Error("test store requires a caller-supplied nonce");
      }
      const row: Approval = {
        approvalId: randomUUID(),
        tenantId: approval.tenantId ?? "basileia",
        runId: approval.runId,
        capabilityId: approval.capabilityId,
        actionDigest: Buffer.from(approval.actionDigest),
        actionRender: approval.actionRender,
        destination: approval.destination,
        nonce: approval.nonce,
        status: "pending",
        requestedAt: new Date(),
        expiresAt: approval.expiresAt,
        decidedBy: null,
        decidedAt: null,
        consumedAt: null,
      };
      rows.set(row.nonce, row);
      return row;
    },
    async getByNonce(nonce: string): Promise<Approval | null> {
      return rows.get(nonce) ?? null;
    },
    async consume(nonce: string): Promise<ConsumeApprovalResult> {
      events.push("consume");
      const row = rows.get(nonce);
      if (
        row === undefined ||
        row.status !== "granted" ||
        row.expiresAt.getTime() <= Date.now() ||
        row.consumedAt !== null
      ) {
        return { rowCount: 0, approval: null };
      }
      const consumed: Approval = {
        ...row,
        status: "consumed",
        consumedAt: new Date(),
      };
      rows.set(nonce, consumed);
      return { rowCount: 1, approval: consumed };
    },
    async invalidate(nonce: string): Promise<ConsumeApprovalResult> {
      events.push("invalidate");
      const row = rows.get(nonce);
      if (row === undefined || row.status !== "granted" || row.consumedAt !== null) {
        return { rowCount: 0, approval: null };
      }
      const invalidated: Approval = {
        ...row,
        status: "invalidated",
      };
      rows.set(nonce, invalidated);
      return { rowCount: 1, approval: invalidated };
    },
    async expirePending(scope?: { readonly runId: string }): Promise<number> {
      events.push("expire");
      const now = Date.now();
      let expired = 0;
      for (const [nonce, row] of rows) {
        if (row.status !== "pending" || row.expiresAt.getTime() > now) {
          continue;
        }
        if (scope !== undefined && row.runId !== scope.runId) {
          continue;
        }
        rows.set(nonce, { ...row, status: "expired" });
        expired += 1;
      }
      return expired;
    },
  };

  return { store, rows, events };
}

export function grantMemoryRow(row: Approval, expiresAt?: Date): Approval {
  const granted: Approval = {
    ...row,
    status: "granted",
    decidedBy: "test:task-014",
    decidedAt: new Date(),
    expiresAt: expiresAt ?? row.expiresAt,
    consumedAt: null,
  };
  return granted;
}
