import { describe, expect, it } from "vitest";

import {
  PolicyMissingError,
  PolicyRegistry,
  StalePolicyEntryError,
} from "./registry.js";

const LIST = "mcp__gmail__list_messages";
const DRAFT = "mcp__gmail__create_draft";
const SEND = "mcp__gmail__send_message";

const listPolicy = { toolName: LIST, capabilityId: "email.list" };
const draftPolicy = { toolName: DRAFT, capabilityId: "email.create_draft" };
const sendPolicy = { toolName: SEND, capabilityId: "email.send" };

describe("PolicyRegistry — construction-time completeness (study §Tier 1.4)", () => {
  it("constructs when every mounted tool maps to a policy and every policy is manifest-mapped", () => {
    const registry = new PolicyRegistry({
      mountedToolNames: [LIST, DRAFT],
      policies: { [LIST]: listPolicy, [DRAFT]: draftPolicy },
      manifestToolNames: [LIST, DRAFT],
    });

    expect(registry.mountedToolNames).toEqual([DRAFT, LIST]);
    expect(registry.has(LIST)).toBe(true);
    expect(registry.has(DRAFT)).toBe(true);
    expect(registry.has(SEND)).toBe(false);
    expect(registry.manifestMap.has(LIST)).toBe(true);
  });

  it("accepts a Map and an array of policy entries", () => {
    const fromMap = new PolicyRegistry({
      mountedToolNames: [LIST],
      policies: new Map([[LIST, listPolicy]]),
      manifestToolNames: [LIST],
    });
    const fromArray = new PolicyRegistry({
      mountedToolNames: [LIST],
      policies: [listPolicy],
      manifestToolNames: [LIST],
    });

    expect(fromMap.has(LIST)).toBe(true);
    expect(fromArray.policies.get(LIST)).toEqual(listPolicy);
  });

  it("throws PolicyMissingError naming the tool when a mounted tool has no policy (ADR-005 liveness)", () => {
    let caught: unknown;
    try {
      new PolicyRegistry({
        mountedToolNames: [LIST, SEND],
        policies: { [LIST]: listPolicy },
        manifestToolNames: [LIST, SEND],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PolicyMissingError);
    const named = caught as PolicyMissingError;
    expect(named.toolName).toBe(SEND);
    expect(named.missing).toEqual([SEND]);
    expect(named.message).toContain(SEND);
    expect(named.name).toBe("PolicyMissingError");
  });

  it("names every unmapped mounted tool, sorted", () => {
    try {
      new PolicyRegistry({
        mountedToolNames: [SEND, LIST, DRAFT],
        policies: { [LIST]: listPolicy },
        manifestToolNames: [LIST, DRAFT, SEND],
      });
      expect.unreachable("construction must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyMissingError);
      const named = error as PolicyMissingError;
      expect(named.missing).toEqual([DRAFT, SEND]);
      expect(named.toolName).toBe(DRAFT);
      expect(named.message).toContain(DRAFT);
      expect(named.message).toContain(SEND);
    }
  });

  it("throws StalePolicyEntryError when a policy names a tool no manifest maps (study §6.2)", () => {
    let caught: unknown;
    try {
      new PolicyRegistry({
        mountedToolNames: [LIST],
        policies: { [LIST]: listPolicy, [SEND]: sendPolicy },
        manifestToolNames: [LIST],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StalePolicyEntryError);
    const named = caught as StalePolicyEntryError;
    expect(named.toolName).toBe(SEND);
    expect(named.stale).toEqual([SEND]);
    expect(named.message).toContain(SEND);
    expect(named.name).toBe("StalePolicyEntryError");
  });

  it("prefers PolicyMissingError over stale-entry when both would apply", () => {
    // Mounted SEND has no policy AND leftover DRAFT policy is unmapped.
    expect(() => new PolicyRegistry({
      mountedToolNames: [LIST, SEND],
      policies: { [LIST]: listPolicy, [DRAFT]: draftPolicy },
      manifestToolNames: [LIST],
    })).toThrow(PolicyMissingError);
  });

  it("rejects a mounted empty name as a missing policy", () => {
    expect(() => new PolicyRegistry({
      mountedToolNames: [""],
      policies: { [LIST]: listPolicy },
      manifestToolNames: [LIST],
    })).toThrow(PolicyMissingError);
  });

  it("treats duplicate mounted names as one requirement", () => {
    const registry = new PolicyRegistry({
      mountedToolNames: [LIST, LIST],
      policies: { [LIST]: listPolicy },
      manifestToolNames: [LIST],
    });
    expect(registry.mountedToolNames).toEqual([LIST]);
  });
});
