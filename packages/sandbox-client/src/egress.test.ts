import { describe, expect, it } from "vitest";

import { toOpenSandboxNetworkPolicy } from "./egress.js";

describe("toOpenSandboxNetworkPolicy", () => {
  it("creates an explicit allow policy so the sidecar and liveness marker exist", () => {
    expect(toOpenSandboxNetworkPolicy({ mode: "allow_all", hosts: [] })).toEqual({ defaultAction: "allow", egress: [] });
  });

  it("fails closed for an allowlist-only policy", () => {
    expect(toOpenSandboxNetworkPolicy({ mode: "allowlist_only", hosts: ["api.example.test"] }))
      .toEqual({ defaultAction: "deny", egress: [{ action: "allow", target: "api.example.test" }] });
  });
});
