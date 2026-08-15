import { describe, expect, it } from "vitest";

import {
  evaluateDomainConstraint,
  evaluateRateLimitConstraint,
  type RoleConstraints,
} from "../src/index.js";

/** Inbox-triage seed shape from Handover §4.4 / TASK-006. */
const inboxTriageConstraints: RoleConstraints = {
  rate_per_hour: 40,
  domains: ["*"],
};

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

  it("enforces rate limit without consulting domains", () => {
    // Domain would allow anything via "*"; rate alone still denies.
    const rateDecision = evaluateRateLimitConstraint({
      ratePerHour: inboxTriageConstraints.rate_per_hour,
      currentUsageCount: 40,
    });
    const domainDecision = evaluateDomainConstraint({
      allowedDomains: inboxTriageConstraints.domains,
      targetDomain: "anywhere.example",
    });

    expect(rateDecision).toEqual({
      decision: "deny",
      reason: "constraint.rate_per_hour",
    });
    expect(domainDecision).toEqual({ decision: "allow" });
    expect(rateDecision).not.toEqual(domainDecision);
  });
});

describe("evaluateDomainConstraint", () => {
  it("allows when domains is absent (no domain constraint)", () => {
    expect(
      evaluateDomainConstraint({
        allowedDomains: undefined,
        targetDomain: "glacier.co.za",
      }),
    ).toEqual({ decision: "allow" });
  });

  it("allows any target when the allowlist is the inbox-triage [\"*\"] wildcard", () => {
    expect(
      evaluateDomainConstraint({
        allowedDomains: inboxTriageConstraints.domains,
        targetDomain: "unlisted.example.com",
      }),
    ).toEqual({ decision: "allow" });
  });

  it("allows an exact match against a concrete domain allowlist", () => {
    expect(
      evaluateDomainConstraint({
        allowedDomains: ["glacier.co.za", "basileia.tech"],
        targetDomain: "glacier.co.za",
      }),
    ).toEqual({ decision: "allow" });
  });

  it("denies with constraint.domains when the target is not on the allowlist", () => {
    expect(
      evaluateDomainConstraint({
        allowedDomains: ["glacier.co.za"],
        targetDomain: "evil.example",
      }),
    ).toEqual({ decision: "deny", reason: "constraint.domains" });
  });

  it("denies an empty allowlist (fail closed)", () => {
    expect(
      evaluateDomainConstraint({
        allowedDomains: [],
        targetDomain: "glacier.co.za",
      }),
    ).toEqual({ decision: "deny", reason: "constraint.domains" });
  });

  it("enforces domain constraint without consulting rate_per_hour", () => {
    // Rate would still allow (usage 0); domain alone denies non-matching target.
    const domainDecision = evaluateDomainConstraint({
      allowedDomains: ["glacier.co.za"],
      targetDomain: "evil.example",
    });
    const rateDecision = evaluateRateLimitConstraint({
      ratePerHour: 40,
      currentUsageCount: 0,
    });

    expect(domainDecision).toEqual({
      decision: "deny",
      reason: "constraint.domains",
    });
    expect(rateDecision).toEqual({ decision: "allow" });
    expect(domainDecision).not.toEqual(rateDecision);
  });
});

describe("constraint denial reason distinguishability", () => {
  it("returns different reason strings per constraint for audit", () => {
    const rateDeny = evaluateRateLimitConstraint({
      ratePerHour: 1,
      currentUsageCount: 1,
    });
    const domainDeny = evaluateDomainConstraint({
      allowedDomains: ["only.allowed"],
      targetDomain: "other.domain",
    });

    expect(rateDeny).toEqual({
      decision: "deny",
      reason: "constraint.rate_per_hour",
    });
    expect(domainDeny).toEqual({
      decision: "deny",
      reason: "constraint.domains",
    });
    if (rateDeny.decision === "deny" && domainDeny.decision === "deny") {
      expect(rateDeny.reason).not.toBe(domainDeny.reason);
    }
  });
});
