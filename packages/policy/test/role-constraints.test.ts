import { describe, expect, it } from "vitest";

import { evaluateRateLimitConstraint, type RoleConstraints } from "../src/index.js";

/** Inbox-triage seed shape from Handover §4.4 / TASK-006. */
const inboxTriageConstraints: RoleConstraints = {
  rate_per_hour: 40,
  domains: ["*"],
};

// `domains` (`evaluateDomainConstraint`) was removed in TASK-227: confirmed
// already live-enforced at the network layer by `resolveEgressPolicy`/
// `toOpenSandboxNetworkPolicy` (`packages/policy/src/egress.ts`), reading
// this exact same `constraints.domains` field and wired into production via
// `services/worker/src/chatRunDriver.ts`. A second, app-level per-call check
// against the same field would have been a redundant, driftable duplicate of
// working enforcement — not a live gap. See PLAN.md TASK-227 Progress_Notes
// for the full investigation trail. `rate_per_hour` had no such coverage
// (genuinely inert until this task), so `evaluateRateLimitConstraint` stays
// and gains a real call site in `packages/broker/src/index.ts`.

describe("evaluateRateLimitConstraint", () => {
  it("allows when rate_per_hour is absent (no rate constraint)", () => {
    expect(
      evaluateRateLimitConstraint({
        ratePerHour: undefined,
        currentUsageCount: 1_000,
      }),
    ).toEqual({ decision: "allow" });
  });

  it("allows when current usage is strictly below the ceiling", () => {
    expect(
      evaluateRateLimitConstraint({
        ratePerHour: inboxTriageConstraints.rate_per_hour,
        currentUsageCount: 39,
      }),
    ).toEqual({ decision: "allow" });
  });

  it("denies with constraint.rate_per_hour when usage equals the ceiling", () => {
    expect(
      evaluateRateLimitConstraint({
        ratePerHour: 40,
        currentUsageCount: 40,
      }),
    ).toEqual({ decision: "deny", reason: "constraint.rate_per_hour" });
  });

  it("denies with constraint.rate_per_hour when usage exceeds the ceiling", () => {
    expect(
      evaluateRateLimitConstraint({
        ratePerHour: 40,
        currentUsageCount: 41,
      }),
    ).toEqual({ decision: "deny", reason: "constraint.rate_per_hour" });
  });
});
