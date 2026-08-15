import {
  getApprovalByNonce,
  insertApproval,
  type Approval,
  type DatabaseOptions,
  type NewApproval,
} from "@oikonomos/db";

export interface ConsumeApprovalResult {
  readonly rowCount: 0 | 1;
  readonly approval: Approval | null;
}

export type ConsumeApprovalFn = (
  options: DatabaseOptions,
  nonce: string,
) => Promise<ConsumeApprovalResult>;

/**
 * Persistence port for issuance and consume. Production uses
 * {@link createDatabaseStore}; tests inject a fake so persist-before-wait
 * and row-count gating can be proven without Postgres.
 */
export interface ApprovalStore {
  insert(approval: NewApproval): Promise<Approval>;
  getByNonce(nonce: string): Promise<Approval | null>;
  consume(nonce: string): Promise<ConsumeApprovalResult>;
}

function isConsumeApprovalFn(value: unknown): value is ConsumeApprovalFn {
  return typeof value === "function";
}

/**
 * Load `consumeApproval` from the db implementation module.
 *
 * The function is authored in `packages/db/src/approvals.ts` (this task's
 * territory). The barrel `packages/db/src/index.ts` is not, so the compiled
 * sibling is loaded rather than a second copy of the statement (OIK-014).
 */
async function loadConsumeApproval(): Promise<ConsumeApprovalFn> {
  // Compiled sibling of the barrel. `packages/db/src/index.ts` is outside
  // this task's Owned_Paths, so consumeApproval cannot be imported from
  // `@oikonomos/db` until ORCH re-exports it.
  const moduleUrl = new URL("../../db/dist/approvals.js", import.meta.url);
  const loaded: unknown = await import(moduleUrl.href);
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("consumeApproval" in loaded) ||
    !isConsumeApprovalFn(loaded.consumeApproval)
  ) {
    throw new Error(
      "consumeApproval missing from @oikonomos/db implementation module; rebuild packages/db.",
    );
  }
  return loaded.consumeApproval;
}

let cachedConsume: ConsumeApprovalFn | undefined;

async function consumeViaDb(
  options: DatabaseOptions,
  nonce: string,
): Promise<ConsumeApprovalResult> {
  if (cachedConsume === undefined) {
    cachedConsume = await loadConsumeApproval();
  }
  return cachedConsume(options, nonce);
}

/** Adapt db persistence (insert / get / consume) to {@link ApprovalStore}. */
export function createDatabaseStore(options: DatabaseOptions): ApprovalStore {
  return {
    insert: (approval) => insertApproval(options, approval),
    getByNonce: (nonce) => getApprovalByNonce(options, nonce),
    consume: (nonce) => consumeViaDb(options, nonce),
  };
}
