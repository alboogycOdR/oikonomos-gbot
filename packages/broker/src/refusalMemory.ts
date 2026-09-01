/**
 * Per-run refusal memory (TASK-073, study §Tier 1.5).
 *
 * A denied action stays denied for the rest of that run. A retrying
 * agent re-asking the operator is a nagging vector and a budget burn.
 * Grok Bot keys this on sha256(target), 512/agent, fail-closed
 * saturation, and non-retroactive grant-widening.
 *
 * Identity is `(runId, tool, sha256(canonical target))`. The digest
 * is `actionDigest` from `@oikonomos/shared` (N10 — no local hash).
 *
 * Bounded: {@link REFUSAL_MEMORY_CAP} entries per run. Overflow does
 * not evict (forgetting a refusal fails open); the run is marked
 * saturated and every further action in it is auto-denied.
 *
 * Grant-widening is not retroactive: `widenGrants` bumps an epoch, and
 * an auto-allow applies only to actions initiated at or after that
 * epoch. A previously denied action stays denied regardless.
 *
 * In-process only. Persistence across worker restarts is out of
 * scope — a restart re-parks, which is safe (re-ASK, not re-run).
 *
 * `packages/broker/src/index.ts` is outside Owned_Paths; this module
 * is not re-exported from the package root. Later L1 wiring imports
 * it directly.
 */

import { actionDigest, type JsonValue } from "@oikonomos/shared";

import { denyDecision, type DenyDecision } from "./decision.js";

/** Grok Bot `512/agent` cap. Overflow saturates the run rather than evicting. */
export const REFUSAL_MEMORY_CAP = 512;

/** Fixed namespace so the shared digest hashes the canonical target, not a second sha256. */
const TARGET_DIGEST_TOOL = "refusal.target";

export interface RefusalAction {
  readonly runId: string;
  readonly tool: string;
  /** Canonical action identity (described target string, or structured payload). */
  readonly target: JsonValue;
}

export type RefusalConsult =
  | {
      readonly decision: "proceed";
      readonly grantEpoch: number;
      /** False when this action was initiated before the latest grant-widening. */
      readonly grantsApply: boolean;
    }
  | DenyDecision;

/**
 * Current-policy outcome *without* memory. `allow` is auto-allow;
 * `proceed` means the caller may park for approval; `deny` is a
 * refusal to record.
 */
export type PolicyDecision =
  | DenyDecision
  | { readonly decision: "allow" }
  | { readonly decision: "proceed" };

interface RunState {
  saturated: boolean;
  readonly refusals: Map<string, true>;
  readonly initiations: Map<string, number>;
}

function assertAction(action: RefusalAction): void {
  if (typeof action.runId !== "string" || action.runId.length === 0) {
    throw new RangeError("refusal memory: runId must be a non-empty string");
  }
  if (typeof action.tool !== "string" || action.tool.length === 0) {
    throw new RangeError("refusal memory: tool must be a non-empty string");
  }
}

/**
 * sha256(canonical target) via the single shared digest (N10).
 * `toolName`/`destination` are a fixed namespace — they are not part
 * of the action identity; `tool` is a separate component of the key.
 */
function canonicalTargetDigest(target: JsonValue): string {
  return actionDigest({
    toolName: TARGET_DIGEST_TOOL,
    input: target,
    destination: "",
  });
}

function entryKey(tool: string, target: JsonValue): string {
  return `${tool}\0${canonicalTargetDigest(target)}`;
}

export class RefusalMemory {
  #epoch = 0;
  readonly #runs = new Map<string, RunState>();

  /** Current grant-widening epoch. Starts at 0; `widenGrants` increments. */
  get grantEpoch(): number {
    return this.#epoch;
  }

  /**
   * Record that policy/tier was widened to auto-allow. Subsequent
   * actions see the new epoch; already-initiated actions do not.
   */
  widenGrants(): number {
    this.#epoch += 1;
    return this.#epoch;
  }

  isSaturated(runId: string): boolean {
    return this.#runs.get(runId)?.saturated === true;
  }

  /**
   * Gate an action. Records initiation epoch on first sight.
   * A remembered refusal or a saturated run returns a TASK-067
   * {@link DenyDecision} — the caller must not park for approval.
   */
  consult(action: RefusalAction): RefusalConsult {
    assertAction(action);
    const state = this.#run(action.runId);
    const key = entryKey(action.tool, action.target);
    if (!state.initiations.has(key)) {
      state.initiations.set(key, this.#epoch);
    }
    if (state.refusals.has(key)) {
      return denyDecision("refusal.abandoned");
    }
    if (state.saturated) {
      return denyDecision("refusal.saturated");
    }
    const initiatedAt = state.initiations.get(key) ?? this.#epoch;
    return Object.freeze({
      decision: "proceed",
      grantEpoch: this.#epoch,
      grantsApply: initiatedAt >= this.#epoch,
    });
  }

  /**
   * Record a denial so repeats of the same `(tool, target)` in this
   * run are auto-denied. A new key at the cap saturates the run
   * instead of evicting an existing refusal.
   */
  rememberDenial(action: RefusalAction): void {
    assertAction(action);
    const state = this.#run(action.runId);
    if (state.saturated) return;
    const key = entryKey(action.tool, action.target);
    if (!state.initiations.has(key)) {
      state.initiations.set(key, this.#epoch);
    }
    if (state.refusals.has(key)) return;
    if (state.refusals.size >= REFUSAL_MEMORY_CAP) {
      state.saturated = true;
      return;
    }
    state.refusals.set(key, true);
  }

  #run(runId: string): RunState {
    let state = this.#runs.get(runId);
    if (state === undefined) {
      state = { saturated: false, refusals: new Map(), initiations: new Map() };
      this.#runs.set(runId, state);
    }
    return state;
  }
}

/**
 * Decision-path helper: consult memory first; only invoke `ask` when
 * the action is not already refused. A policy deny is recorded so
 * retries stick. A policy allow is honoured only when `grantsApply`.
 *
 * MUTATION target: skipping the consult (always calling `ask`)
 * re-parks a previously refused action and reddens the mutation test.
 */
export function decideWithRefusalMemory(
  memory: RefusalMemory,
  action: RefusalAction,
  ask: () => PolicyDecision,
): PolicyDecision {
  const check = memory.consult(action);
  if (check.decision === "deny") {
    return check;
  }
  // Study §Tier 1.5: a remembered refusal must not re-park. MUTATION:
  // calling ask() without the consult above reddens refusalMemory.test.ts.
  const policy = ask();
  if (policy.decision === "allow" && !check.grantsApply) {
    return Object.freeze({ decision: "proceed" as const });
  }
  if (policy.decision === "deny") {
    memory.rememberDenial(action);
  }
  return policy;
}
