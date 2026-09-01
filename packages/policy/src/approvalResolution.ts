/** The four choices an operator may make when resolving an approval prompt. */
export enum ApprovalResolution {
  AllowOnce = "allow-once",
  Deny = "deny",
  Always = "always",
  Never = "never",
}

/** A persisted standing policy for a role/capability pair. `ask` is the safe default. */
export type StandingApprovalMode = "always" | "ask" | "never";

/** The action a caller must take for this individual request. */
export type ApprovalRequestDecision = "allow-once" | "deny" | "ask";

export interface ResolveApprovalRequestInput {
  /** Undefined when evaluating a new request before an operator has answered it. */
  resolution: ApprovalResolution | undefined;
  existingStandingMode: StandingApprovalMode | undefined;
  /** An organisation policy which may only make a standing mode more restrictive. */
  adminCeiling: StandingApprovalMode | undefined;
  requestedAtEpoch: number;
  standingModeSetAtEpoch: number | undefined;
}

export interface ApprovalRequestResolution {
  decision: ApprovalRequestDecision;
  /**
   * A mode selected by an explicit `always` or `never` operator resolution.
   * The caller owns persistence; this module performs no I/O.
   */
  standingModeToPersist: StandingApprovalMode | undefined;
}

/** Ordered from least to most restrictive. Exhaustive over `StandingApprovalMode`. */
const standingModeRanks = {
  always: 0,
  ask: 1,
  never: 2,
} satisfies Record<StandingApprovalMode, number>;

/**
 * Resolves an operator response or a previously persisted standing mode.
 *
 * A standing policy is deliberately non-retroactive: it applies only to a
 * request created at or after the epoch at which that policy was set.
 */
export function resolveApprovalRequest(
  input: ResolveApprovalRequestInput,
): ApprovalRequestResolution {
  if (input.resolution !== undefined) {
    return resolveExplicitResolution(input.resolution, input.adminCeiling);
  }

  if (
    input.existingStandingMode === undefined ||
    input.standingModeSetAtEpoch === undefined ||
    input.requestedAtEpoch < input.standingModeSetAtEpoch
  ) {
    return { decision: "ask", standingModeToPersist: undefined };
  }

  return {
    decision: resolveStandingMode(
      clampStandingMode(input.existingStandingMode, input.adminCeiling),
    ),
    standingModeToPersist: undefined,
  };
}

function resolveExplicitResolution(
  resolution: ApprovalResolution,
  adminCeiling: StandingApprovalMode | undefined,
): ApprovalRequestResolution {
  const resolutions = {
    [ApprovalResolution.AllowOnce]: (): ApprovalRequestResolution => ({
      decision: "allow-once",
      standingModeToPersist: undefined,
    }),
    [ApprovalResolution.Deny]: (): ApprovalRequestResolution => ({
      decision: "deny",
      standingModeToPersist: undefined,
    }),
    [ApprovalResolution.Always]: (): ApprovalRequestResolution => {
      const standingMode = clampStandingMode("always", adminCeiling);
      return {
        decision: standingMode === "never" ? "deny" : "allow-once",
        standingModeToPersist: standingMode,
      };
    },
    [ApprovalResolution.Never]: (): ApprovalRequestResolution => ({
      decision: "deny",
      standingModeToPersist: "never",
    }),
  } satisfies Record<ApprovalResolution, () => ApprovalRequestResolution>;

  return resolutions[resolution]();
}

function clampStandingMode(
  requested: StandingApprovalMode,
  ceiling: StandingApprovalMode | undefined,
): StandingApprovalMode {
  if (ceiling === undefined) {
    return requested;
  }

  return standingModeRanks[requested] >= standingModeRanks[ceiling]
    ? requested
    : ceiling;
}

function resolveStandingMode(
  standingMode: StandingApprovalMode,
): ApprovalRequestDecision {
  const decisions = {
    always: "allow-once",
    ask: "ask",
    never: "deny",
  } satisfies Record<StandingApprovalMode, ApprovalRequestDecision>;

  return decisions[standingMode];
}
