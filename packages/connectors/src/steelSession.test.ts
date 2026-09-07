import { describe, expect, it } from "vitest";

import {
  assertNoHumanTakeoverRequired,
  createSteelSessionConfig,
  detectHumanTakeover,
  HumanTakeoverRequiredError,
} from "./steelSession.js";

describe("Steel session configuration", () => {
  it("uses an isolated sealed profile, local MCP transport, an allowlist, and no stealth", () => {
    const config = createSteelSessionConfig({
      roleId: "inbox-triage",
      allowedHosts: ["Example.COM", "accounts.example.com", "example.com"],
    });

    expect(config).toMatchObject({
      profileDirectory: "/oikonomos/secrets/browser-profiles/inbox-triage",
      profileOwnership: "bot_private",
      profileMode: 0o700,
      browserBaseUrl: "http://127.0.0.1:3000",
      egressAllowlist: ["accounts.example.com", "example.com"],
      stealth: false,
      antiDetection: false,
      mcpServer: {
        command: "node",
        env: { STEEL_LOCAL: "true", STEEL_BASE_URL: "http://127.0.0.1:3000", STEEL_PROFILE: "browse" },
      },
    });
  });

  it("rejects profile traversal, non-loopback browser endpoints, and malformed allowlist hosts", () => {
    expect(() => createSteelSessionConfig({ roleId: "../other", allowedHosts: [] })).toThrow("safe identifier");
    expect(() => createSteelSessionConfig({ roleId: "role", allowedHosts: [], browserBaseUrl: "https://steel.dev" })).toThrow("loopback");
    expect(() => createSteelSessionConfig({ roleId: "role", allowedHosts: ["https://example.com"] })).toThrow("invalid host");
  });
});

describe("human takeover detection", () => {
  it.each([
    ["captcha", "<main>Please verify you are human with CAPTCHA</main>"],
    ["two_factor", "<main>Enter your one-time code from your authenticator app</main>"],
    ["login_wall", "<main>Sign in to continue</main>"],
    ["payment", "<main>Checkout: confirm payment</main>"],
  ] as const)("returns a typed %s signal for a local fixture page", (kind, fixture) => {
    expect(detectHumanTakeover(fixture)).toMatchObject({ kind });
    expect(() => assertNoHumanTakeoverRequired(fixture)).toThrow(HumanTakeoverRequiredError);
  });

  it("leaves ordinary page content alone", () => {
    expect(detectHumanTakeover("<main>Quarterly report</main>")).toBeUndefined();
  });
});
