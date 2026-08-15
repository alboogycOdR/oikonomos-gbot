import { randomUUID } from "node:crypto";

import type { Approval, NewApproval } from "@oikonomos/db";

import type { ApprovalStore } from "../src/store.js";
import type { IssueApprovalRequest } from "../src/issue.js";

export const FIXTURE_RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

export function fixtureRequest(
  overrides: Partial<IssueApprovalRequest> = {},
): IssueApprovalRequest {
  return {
    runId: FIXTURE_RUN_ID,
    capabilityId: "email.create_draft",
    toolName: "mcp__gmail__create_draft",
    input: { to: "review@example.test", subject: "placeholder subject" },
    destination: "review@example.test",
    actionRender: "create draft to review@example.test",
    ...overrides,
  };
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
  };

  return { store, rows, events };
}
