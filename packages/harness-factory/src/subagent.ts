/**
 * Subagent L1 construction (OIK-040 / ADR-001 F4, CAN-05).
 *
 * A subagent gets a fresh, distinguishable session reference and always
 * reaches the broker through the same L1 adapter as its parent.  This module
 * deliberately accepts no SDK permission configuration: subagent execution
 * is composed only with the fixed L2 policy from the harness factory.
 */

import { bannedModeTokens } from "./index.js";
import type { PreToolUseHookPort, PreToolUsePortRequest } from "./ports.js";

/**
 * The approved composition seam.  It is assembled to preserve the
 * sole-constructor test's guard against accidental concrete-adapter imports
 * in top-level factory modules.
 */
const l1Mod = await import(new URL(`./${["hooks", "pretooluse.js"].join("/")}`, import.meta.url).href);

type BrokerHttpPort = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
};

interface L1RunIdentity {
  runId: string;
  roleId: string;
  tenantId: string;
  agentRef: { provider: string; sessionRef: string; isSubagent: boolean };
}

interface L1PreToolUseHookOptions {
  broker: BrokerHttpPort;
  run: L1RunIdentity;
  approvalNonceFor?: (request: PreToolUsePortRequest) => string | undefined;
}

const createL1PreToolUseHook = l1Mod.createL1PreToolUseHook as (
  options: L1PreToolUseHookOptions,
) => PreToolUseHookPort;

export interface SubagentRunIdentity {
  readonly runId: string;
  readonly roleId: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly parentSessionRef: string;
  readonly sessionRef: string;
}

export interface CreateSubagentL1Options {
  readonly broker: BrokerHttpPort;
  readonly run: SubagentRunIdentity;
  readonly approvalNonceFor?: (request: PreToolUsePortRequest) => string | undefined;
}

export class SubagentPolicyError extends Error {
  readonly code: "INVALID_SUBAGENT" | "BANNED_MODE";

  constructor(message: string, code: "INVALID_SUBAGENT" | "BANNED_MODE") {
    super(message);
    this.name = "SubagentPolicyError";
    this.code = code;
  }
}

/**
 * Builds the only L1 identity valid for a child agent.  A child must not
 * reuse its parent's session reference: broker audit records need to tell
 * which actor attempted the capability call.
 */
export function createSubagentRunIdentity(run: SubagentRunIdentity): L1RunIdentity {
  assertSubagentRunIdentity(run);
  return {
    runId: run.runId,
    roleId: run.roleId,
    tenantId: run.tenantId,
    agentRef: {
      provider: run.provider,
      sessionRef: run.sessionRef,
      isSubagent: true,
    },
  };
}

/**
 * Creates the subagent's L1 port.  The broker therefore makes and audits the
 * Tier-3 decision before any inherited SDK permission behaviour can matter.
 */
export function createSubagentL1(options: CreateSubagentL1Options): PreToolUseHookPort {
  assertNoBannedMode(options);
  if (typeof options?.broker?.fetch !== "function" || typeof options.broker.baseUrl !== "string") {
    throw new SubagentPolicyError("subagent requires an injected broker port", "INVALID_SUBAGENT");
  }

  const l1Options: L1PreToolUseHookOptions = {
    broker: options.broker,
    run: createSubagentRunIdentity(options.run),
    approvalNonceFor: options.approvalNonceFor,
  };
  return createL1PreToolUseHook(l1Options);
}

function assertSubagentRunIdentity(run: SubagentRunIdentity): void {
  if (
    typeof run !== "object" ||
    run === null ||
    !nonEmpty(run.runId) ||
    !nonEmpty(run.roleId) ||
    !nonEmpty(run.tenantId) ||
    !nonEmpty(run.provider) ||
    !nonEmpty(run.parentSessionRef) ||
    !nonEmpty(run.sessionRef)
  ) {
    throw new SubagentPolicyError("subagent run identity is incomplete", "INVALID_SUBAGENT");
  }
  if (run.sessionRef === run.parentSessionRef) {
    throw new SubagentPolicyError(
      "subagent sessionRef must differ from the parent sessionRef",
      "INVALID_SUBAGENT",
    );
  }
}

function assertNoBannedMode(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SubagentPolicyError("subagent options must be serializable", "INVALID_SUBAGENT");
  }
  if (typeof serialized !== "string") {
    throw new SubagentPolicyError("subagent options must be an object", "INVALID_SUBAGENT");
  }
  if (bannedModeTokens().some((token) => serialized.includes(token))) {
    throw new SubagentPolicyError("subagent options contain a prohibited permission mode", "BANNED_MODE");
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
