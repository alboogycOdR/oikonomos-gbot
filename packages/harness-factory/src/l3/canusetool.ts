/**
 * L3 canUseTool adapter (OIK-035 / ADR-001 L3).
 *
 * L3 is a secondary decision point for SDK calls which reach canUseTool
 * (notably the F5 interaction class). L1 remains the enforcement point.
 * Delegating its HTTP work to the L1 adapter keeps the POST endpoint,
 * request shape, timeout, and fail-closed mapping identical. In particular,
 * forwarding the original toolUseId lets the broker apply its R2
 * idempotency when L1 and L3 see the same tool invocation.
 */

import type {
  CanUseToolPort,
  CanUseToolPortDecision,
  CanUseToolPortRequest,
} from "../ports.js";
import {
  createL1PreToolUseHook,
  type L1PreToolUseHookOptions,
} from "../hooks/pretooluse.js";

export interface L3CanUseToolOptions extends L1PreToolUseHookOptions {}

/**
 * Creates the L3 secondary callback using the same injected broker seam as
 * L1. It deliberately does not cache or make a local authorization decision:
 * the broker is the R2 idempotency authority shared by both layers.
 */
export function createL3CanUseTool(options: L3CanUseToolOptions): CanUseToolPort {
  const l1Transport = createL1PreToolUseHook(options);

  return {
    async canUseTool(request: CanUseToolPortRequest): Promise<CanUseToolPortDecision> {
      const decision = await l1Transport.handle(request);
      if (decision.decision === "allow") {
        return {
          behavior: "allow",
          updatedInput: decision.updatedInput ?? request.input,
        };
      }
      return { behavior: "deny", message: decision.message };
    },
  };
}
