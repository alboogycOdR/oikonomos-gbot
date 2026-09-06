import { describe, expect, it } from "vitest";

import { describeRequestSecret, parseRequestSecretInput } from "./requestSecret.js";

describe("request_secret input", () => {
  it("accepts a bounded label and purpose and derives the approval description", () => {
    expect(parseRequestSecretInput({ label: "GitHub token", purpose: "publish the release" })).toEqual({ label: "GitHub token", purpose: "publish the release" });
    expect(describeRequestSecret({ toolName: "mcp__workspace__request_secret", input: { label: "GitHub token", purpose: "publish the release" } })).toEqual({ action: "request secret", target: "GitHub token — publish the release" });
  });

  it("refuses oversized, malformed, and extra-field payloads before approval", () => {
    expect(() => parseRequestSecretInput({ label: "x".repeat(201), purpose: "p" })).toThrow(/at most/);
    expect(() => parseRequestSecretInput({ label: "x", purpose: "p", secret: "never" })).toThrow(/exactly/);
    expect(describeRequestSecret({ toolName: "mcp__workspace__request_secret", input: { label: "x", purpose: 7 } })).toBeUndefined();
  });
});
