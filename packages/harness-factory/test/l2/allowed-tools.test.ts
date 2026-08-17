import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isL2Policy, L2_PERMISSION_MODE } from "../../src/config.js";
import {
  ADR_NAMED_BARE_TOOLS,
  CAN02_TIER3_BARE_NAME,
  classifyAllowedTool,
  createL2Policy,
  explicitSurfaceToolNames,
  isBareNameAllowedTool,
  isListedOnL2Surface,
  isScopedAllowedTool,
  L2ConfigError,
  validateAllowedTool,
  validateL2Policy,
  type AdrNamedBareToolRegistry,
} from "../../src/l2/allowed-tools.js";

const validatorSource = readFileSync(
  fileURLToPath(new URL("../../src/l2/allowed-tools.ts", import.meta.url)),
  "utf8",
);

function expectBareNameRejection(fn: () => unknown, entry: string): void {
  try {
    fn();
    expect.unreachable(`expected bare-name rejection for ${entry}`);
  } catch (err) {
    expect(err).toBeInstanceOf(L2ConfigError);
    const error = err as L2ConfigError;
    expect(error.code).toBe("BARE_NAME");
    expect(error.entry).toBe(entry);
    expect(error.message).toMatch(/bare-name/i);
  }
}

describe("createL2Policy — dontAsk + explicit surface (ADR-001 L2)", () => {
  it("fixes permissionMode to dontAsk and freezes the allowlist", () => {
    const policy = createL2Policy(["Bash(ls *)", "Read(src/**)"]);

    expect(policy.permissionMode).toBe(L2_PERMISSION_MODE);
    expect(policy.permissionMode).toBe("dontAsk");
    expect(policy.allowedTools).toEqual(["Bash(ls *)", "Read(src/**)"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowedTools)).toBe(true);
    expect(isL2Policy(policy)).toBe(true);
  });

  it("treats unlisted tools as off the explicit surface (hard-denied, not callback-reliant)", () => {
    const policy = createL2Policy(["Bash(ls *)", "Read(src/**)"]);

    expect(explicitSurfaceToolNames(policy)).toEqual(["Bash", "Read"]);
    expect(isListedOnL2Surface(policy, "Bash")).toBe(true);
    expect(isListedOnL2Surface(policy, "Read")).toBe(true);
    expect(isListedOnL2Surface(policy, CAN02_TIER3_BARE_NAME)).toBe(false);
    expect(isListedOnL2Surface(policy, "Write")).toBe(false);
    expect(policy.permissionMode).toBe("dontAsk");
  });

  it("rejects any permissionMode other than dontAsk", () => {
    expect(() =>
      validateL2Policy({ permissionMode: "default", allowedTools: ["Bash(ls *)"] }),
    ).toThrow(L2ConfigError);
    expect(() =>
      validateL2Policy({ permissionMode: "plan", allowedTools: ["Bash(ls *)"] }),
    ).toThrow(/dontAsk/);
    expect(() =>
      validateL2Policy({ permissionMode: "dontAsk", allowedTools: "Bash(ls *)" }),
    ).toThrow(/explicit array/);
    expect(() => validateL2Policy(null)).toThrow(L2ConfigError);
  });

  it("accepts an empty allowlist (fail-closed: every tool is unlisted)", () => {
    const policy = createL2Policy([]);
    expect(policy.allowedTools).toEqual([]);
    expect(isListedOnL2Surface(policy, "Read")).toBe(false);
  });
});

describe("R1/F2 — scoped form accepted, bare names rejected", () => {
  it("accepts scoped-form entries", () => {
    expect(isScopedAllowedTool("Bash(ls *)")).toBe(true);
    expect(isScopedAllowedTool("Read(src/**)")).toBe(true);
    expect(isScopedAllowedTool("mcp__github__get_issue(basileia/*)")).toBe(true);
    expect(classifyAllowedTool("Bash(ls *)")).toEqual({
      kind: "scoped",
      name: "Bash",
      spec: "ls *",
      entry: "Bash(ls *)",
    });

    const policy = createL2Policy([
      "Bash(ls *)",
      "Read(src/**)",
      "mcp__github__get_issue(basileia/*)",
    ]);
    expect(policy.allowedTools).toHaveLength(3);
  });

  it("rejects bare-name entries unless an ADR amendment names the tool", () => {
    expect(isBareNameAllowedTool("Read")).toBe(true);
    expect(isBareNameAllowedTool("mcp__github__get_issue")).toBe(true);
    expectBareNameRejection(() => validateAllowedTool("Read"), "Read");
    expectBareNameRejection(() => validateAllowedTool("mcp__github__get_issue"), "mcp__github__get_issue");
    expectBareNameRejection(() => createL2Policy(["Read"]), "Read");
    expect(Object.keys(ADR_NAMED_BARE_TOOLS)).toEqual([]);
  });

  it("accepts a bare name only when an ADR amendment names it and justifies it", () => {
    const named: AdrNamedBareToolRegistry = {
      AskUserQuestion: {
        adr: "ADR-TEST",
        justification: "F5 class always reaches canUseTool; listed for the explicit surface",
      },
    };

    expect(validateAllowedTool("AskUserQuestion", named)).toBe("AskUserQuestion");
    const policy = createL2Policy(["AskUserQuestion", "Bash(ls *)"], {
      adrNamedBareTools: named,
    });
    expect(policy.allowedTools).toEqual(["AskUserQuestion", "Bash(ls *)"]);
    expect(isListedOnL2Surface(policy, "AskUserQuestion")).toBe(true);

    expect(() =>
      validateAllowedTool("AskUserQuestion", {
        AskUserQuestion: { adr: "ADR-TEST", justification: "   " },
      }),
    ).toThrow(L2ConfigError);
    expectBareNameRejection(() => validateAllowedTool("AskUserQuestion"), "AskUserQuestion");
  });

  it("rejects malformed entries that are neither scoped nor a bare tool name", () => {
    expect(() => validateAllowedTool("")).toThrow(/empty/);
    expect(() => validateAllowedTool("   ")).toThrow(/empty/);
    expect(() => validateAllowedTool("Bash(")).toThrow(/scoped form/);
    expect(() => validateAllowedTool("Bash()")).toThrow(/scoped form/);
    expect(() => validateAllowedTool("Bash(   )")).toThrow(/scoped form/);
    expect(() => validateAllowedTool("(ls *)")).toThrow(/scoped form/);
    expect(() => validateAllowedTool(42)).toThrow(/strings/);
  });
});

describe("CAN-02 config-layer half — bare-name Tier-3 entry is rejected", () => {
  it("rejects mcp__gmail__send_message as a bare-name allowedTools entry", () => {
    expect(CAN02_TIER3_BARE_NAME).toBe("mcp__gmail__send_message");
    expect(isBareNameAllowedTool(CAN02_TIER3_BARE_NAME)).toBe(true);
    expect(ADR_NAMED_BARE_TOOLS[CAN02_TIER3_BARE_NAME]).toBeUndefined();

    expectBareNameRejection(
      () => createL2Policy([CAN02_TIER3_BARE_NAME]),
      CAN02_TIER3_BARE_NAME,
    );
    expectBareNameRejection(
      () =>
        validateL2Policy({
          permissionMode: L2_PERMISSION_MODE,
          allowedTools: [CAN02_TIER3_BARE_NAME],
        }),
      CAN02_TIER3_BARE_NAME,
    );
  });

  it("still rejects the Tier-3 bare name when mixed with valid scoped entries", () => {
    expectBareNameRejection(
      () => createL2Policy(["Bash(ls *)", CAN02_TIER3_BARE_NAME, "Read(src/**)"]),
      CAN02_TIER3_BARE_NAME,
    );
  });

  it("is live: a pass-through validator would fail this assertion", () => {
    expect(validatorSource).toContain("BARE_NAME");
    expect(validatorSource).toContain("CAN02_TIER3_BARE_NAME");
    expect(validatorSource).not.toMatch(/return value as L2Policy/);
    try {
      createL2Policy([CAN02_TIER3_BARE_NAME]);
      expect.unreachable("inert validator accepted the CAN-02 bare name");
    } catch (err) {
      expect(err).toBeInstanceOf(L2ConfigError);
      expect((err as L2ConfigError).code).toBe("BARE_NAME");
    }
  });
});
