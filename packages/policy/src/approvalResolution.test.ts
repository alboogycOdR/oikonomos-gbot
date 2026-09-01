import { describe, expect, it } from "vitest";

import {
  ApprovalResolution,
  resolveApprovalRequest,
  type StandingApprovalMode,
} from "./approvalResolution.js";

const currentRequest = {
  requestedAtEpoch: 10,
  standingModeSetAtEpoch: undefined,
  existingStandingMode: undefined,
  adminCeiling: undefined,
} as const;

describe("resolveApprovalRequest explicit resolutions", () => {
  it("routes allow-once and deny unchanged without a standing-mode write", () => {
    expect(
      resolveApprovalRequest({ ...currentRequest, resolution: ApprovalResolution.AllowOnce }),
    ).toEqual({ decision: "allow-once", standingModeToPersist: undefined });
    expect(
      resolveApprovalRequest({ ...currentRequest, resolution: ApprovalResolution.Deny }),
    ).toEqual({ decision: "deny", standingModeToPersist: undefined });
  });

  it("returns persistable standing modes only for explicit always and never", () => {
    expect(
      resolveApprovalRequest({ ...currentRequest, resolution: ApprovalResolution.Always }),
    ).toEqual({ decision: "allow-once", standingModeToPersist: "always" });
    expect(
      resolveApprovalRequest({ ...currentRequest, resolution: ApprovalResolution.Never }),
    ).toEqual({ decision: "deny", standingModeToPersist: "never" });
  });
});

describe("resolveApprovalRequest standing modes", () => {
  it("does not retroactively apply a standing mode", () => {
    expect(
      resolveApprovalRequest({
        resolution: undefined,
        existingStandingMode: "always",
        adminCeiling: undefined,
        requestedAtEpoch: 9,
        standingModeSetAtEpoch: 10,
      }),
    ).toEqual({ decision: "ask", standingModeToPersist: undefined });
  });

  it("applies a standing mode at its epoch and thereafter", () => {
    for (const requestedAtEpoch of [10, 11]) {
      expect(
        resolveApprovalRequest({
          resolution: undefined,
          existingStandingMode: "always",
          adminCeiling: undefined,
          requestedAtEpoch,
          standingModeSetAtEpoch: 10,
        }),
      ).toEqual({ decision: "allow-once", standingModeToPersist: undefined });
    }
  });

  it("clamps every standing mode against every administrative ceiling", () => {
    const modes: readonly StandingApprovalMode[] = ["always", "ask", "never"];
    const expectedDecision = { always: "allow-once", ask: "ask", never: "deny" } as const;

    for (const existingStandingMode of modes) {
      for (const adminCeiling of modes) {
        const effectiveMode =
          modes.indexOf(existingStandingMode) >= modes.indexOf(adminCeiling)
            ? existingStandingMode
            : adminCeiling;

        expect(
          resolveApprovalRequest({
            resolution: undefined,
            existingStandingMode,
            adminCeiling,
            requestedAtEpoch: 10,
            standingModeSetAtEpoch: 10,
          }),
        ).toEqual({
          decision: expectedDecision[effectiveMode],
          standingModeToPersist: undefined,
        });
      }
    }
  });

  it("clamps an explicit always to ask or never without widening it", () => {
    expect(
      resolveApprovalRequest({
        ...currentRequest,
        resolution: ApprovalResolution.Always,
        adminCeiling: "ask",
      }),
    ).toEqual({ decision: "allow-once", standingModeToPersist: "ask" });
    expect(
      resolveApprovalRequest({
        ...currentRequest,
        resolution: ApprovalResolution.Always,
        adminCeiling: "never",
      }),
    ).toEqual({ decision: "deny", standingModeToPersist: "never" });
  });
});
