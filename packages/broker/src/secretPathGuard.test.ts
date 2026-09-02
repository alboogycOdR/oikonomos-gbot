import { describe, expect, it, vi } from "vitest";
import { SEALED_SECRET_ROOT } from "@oikonomos/shared";

import {
  SECRET_PATH_AUDIT_EVENT_TYPE,
  SECRET_PATH_DENIAL_REASON,
  guardSecretPath,
  type SecretPathGuardDecision,
} from "./secretPathGuard.js";

const sealedRoot = SEALED_SECRET_ROOT;

interface PermissiveBrokerContext {
  readonly tier: "T0_read" | "T1_draft" | "T2_external_reversible" | "T3_external";
  readonly hasGrant: boolean;
  readonly hasAllowRule: boolean;
}

function invokeTool(
  target: string,
  context: PermissiveBrokerContext = { tier: "T0_read", hasGrant: true, hasAllowRule: true },
  guard: (value: string) => SecretPathGuardDecision = guardSecretPath,
): { readonly outcome: "executed" | "denied"; readonly audit?: object } {
  // The local harness models the most permissive ordinary broker outcome. D3
  // must still stop the executor after every other policy input says allow.
  if (!context.hasGrant || !context.hasAllowRule) return { outcome: "denied" };
  const decision = guard(target);
  if (decision.decision === "deny") return { outcome: "denied", audit: decision.auditEvent };
  return { outcome: "executed" };
}

describe("guardSecretPath — Addendum F N13", () => {
  it.each([
    ["browser profile", `${sealedRoot}/browser-profile/Default/Preferences`, "T0_read"],
    ["cookie store", `${sealedRoot}/browser-profile/Default/Cookies`, "T1_draft"],
    ["connector token", `${sealedRoot}/connector-tokens/opaque-session`, "T2_external_reversible"],
    ["CLI credentials", `${sealedRoot}/cli-credentials/config.json`, "T3_external"],
  ] as const)("denies every D3 pattern despite its tier, grant, and allow rule: %s", (_pattern, target, tier) => {
    expect(invokeTool(target, { tier, hasGrant: true, hasAllowRule: true })).toMatchObject({
      outcome: "denied",
      audit: { type: SECRET_PATH_AUDIT_EVENT_TYPE, reason: SECRET_PATH_DENIAL_REASON },
    });
  });

  it("normalises parent segments and encoded separators before matching", () => {
    expect(invokeTool("/oikonomos/workspace/../../oikonomos/secrets/browser-profile/Cookies")).toEqual({
      outcome: "denied",
      audit: expect.any(Object),
    });
    expect(invokeTool("/oikonomos/secrets%2fbrowser-profile%2fCookies")).toEqual({
      outcome: "denied",
      audit: expect.any(Object),
    });
  });

  it("resolves a symlink target before matching", () => {
    const resolveSymlinks = vi.fn(() => `${sealedRoot}/browser-profile/Default/Cookies`);

    expect(guardSecretPath("/oikonomos/workspace/innocent-link", { resolveSymlinks })).toMatchObject({
      decision: "deny",
      auditEvent: { type: SECRET_PATH_AUDIT_EVENT_TYPE },
    });
    expect(resolveSymlinks).toHaveBeenCalledWith("/oikonomos/workspace/innocent-link");
  });

  it("emits a target-free secret-path event, distinct from an ordinary tier denial", () => {
    const target = `${sealedRoot}/browser-profile/Default/Cookies`;
    const result = invokeTool(target);

    expect(result.audit).toEqual({
      type: SECRET_PATH_AUDIT_EVENT_TYPE,
      verdict: "deny",
      reason: SECRET_PATH_DENIAL_REASON,
    });
    expect(JSON.stringify(result.audit)).not.toContain(target);
    expect(JSON.stringify(result.audit)).not.toContain("secret-value");
  });

  it("LIVENESS: disabling the guard lets a cookie-store read reach the harness executor", () => {
    const target = `${sealedRoot}/browser-profile/Default/Cookies`;

    expect(invokeTool(target)).toMatchObject({ outcome: "denied" });
    expect(invokeTool(target, undefined, () => ({ decision: "allow" }))).toEqual({ outcome: "executed" });
  });

  it("allows a non-D3 workspace target", () => {
    expect(invokeTool("/oikonomos/workspace/report.md")).toEqual({ outcome: "executed" });
  });
});
