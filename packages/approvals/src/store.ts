import {
  getApprovalByNonce,
  insertApproval,
  type Approval,
  type DatabaseOptions,
  type NewApproval,
} from "@oikonomos/db";

/**
 * Persistence port for issuance. Production uses {@link createDatabaseStore};
 * tests inject a fake so persist-before-wait can be proven without Postgres.
 */
export interface ApprovalStore {
  insert(approval: NewApproval): Promise<Approval>;
  getByNonce(nonce: string): Promise<Approval | null>;
}

/** Adapt TASK-020's `insertApproval` / `getApprovalByNonce` to {@link ApprovalStore}. */
export function createDatabaseStore(options: DatabaseOptions): ApprovalStore {
  return {
    insert: (approval) => insertApproval(options, approval),
    getByNonce: (nonce) => getApprovalByNonce(options, nonce),
  };
}
