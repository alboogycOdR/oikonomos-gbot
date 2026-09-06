import { describe, expect, it } from "vitest";

import { resolveEgressPolicy } from "./egress.js";

const manifests = [
  { tools: [{ capability_id: "email.list" }], network_hosts: ["Gmail.googleapis.com"] },
  { tools: [{ capability_id: "drive.list" }], network_hosts: ["www.googleapis.com"] },
] as const;

describe("resolveEgressPolicy", () => {
  it("allows all when no role grant declares domains", () => {
    expect(resolveEgressPolicy({ roleId: "r", grants: [{ capabilityId: "email.list", constraints: {} }] }, manifests))
      .toEqual({ mode: "allow_all", hosts: [] });
  });

  it("combines manifest hosts with explicit role domains", () => {
    expect(resolveEgressPolicy({ roleId: "r", grants: [{ capabilityId: "email.list", constraints: { domains: ["API.example.test"] } }] }, manifests))
      .toEqual({ mode: "defaults_plus_allowlist", hosts: ["api.example.test", "gmail.googleapis.com"] });
  });

  it("allows a granted manifest with no optional default hosts", () => {
    expect(resolveEgressPolicy({ roleId: "r", grants: [{ capabilityId: "calendar.list", constraints: { domains: ["api.example.test"] } }] }, [
      { tools: [{ capability_id: "calendar.list" }] },
    ])).toEqual({ mode: "defaults_plus_allowlist", hosts: ["api.example.test"] });
  });

  it("uses explicit hosts only when any grant opts into strict egress", () => {
    expect(resolveEgressPolicy({ roleId: "r", grants: [
      { capabilityId: "email.list", constraints: { domains: ["only.example.test"] } },
      { capabilityId: "drive.list", constraints: { strictEgress: true } },
    ] }, manifests)).toEqual({ mode: "allowlist_only", hosts: ["only.example.test"] });
  });

  it("drops blank hosts while resolving a deterministic empty strict policy", () => {
    expect(resolveEgressPolicy({ roleId: "r", grants: [
      { capabilityId: "email.list", constraints: { domains: [" ", ""] } },
      { capabilityId: "drive.list", constraints: { strictEgress: true } },
    ] }, manifests)).toEqual({ mode: "allowlist_only", hosts: [] });
  });

  it("ignores malformed persisted domains rather than treating them as a policy", () => {
    expect(resolveEgressPolicy({ roleId: "r", grants: [
      { capabilityId: "email.list", constraints: { domains: ["valid.example", 1] } },
    ] }, manifests)).toEqual({ mode: "allow_all", hosts: [] });
  });

  it("ignores a non-array domains value from legacy JSON", () => {
    expect(resolveEgressPolicy({ roleId: "r", grants: [
      { capabilityId: "email.list", constraints: { domains: "not-an-array" } },
    ] }, manifests)).toEqual({ mode: "allow_all", hosts: [] });
  });
});
