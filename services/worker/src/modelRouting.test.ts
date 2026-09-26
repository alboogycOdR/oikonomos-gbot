import { describe, expect, it } from "vitest";

import { routeModel } from "./modelRouting.js";

const defaults = { provider: "gemini", model: "gemini-default" } as const;
const cheap = { provider: "freellm", model: "free-small" } as const;
const base = {
  kind: "background" as const,
  budgetRemainingUsd: 80,
  budgetCeilingUsd: 100,
  roleProvider: null,
  roleModel: null,
  defaults,
  cheap,
};

describe("routeModel (TASK-364)", () => {
  it("gives an explicit role provider or model precedence over every background or budget rule", () => {
    expect(routeModel({ ...base, budgetRemainingUsd: 1, roleProvider: "claude", roleModel: "sonnet" }))
      .toEqual({ provider: "claude", model: "sonnet", reason: "override" });
    expect(routeModel({ ...base, budgetRemainingUsd: 1, roleModel: "gemini-explicit" }))
      .toEqual({ provider: "gemini", model: "gemini-explicit", reason: "override" });
  });

  it("uses configured cheap routing for background work and never for a chat turn", () => {
    expect(routeModel(base)).toEqual({ provider: "freellm", model: "free-small", reason: "background" });
    expect(routeModel({ ...base, kind: "chat" })).toEqual({ provider: "gemini", model: "gemini-default", reason: "default" });
  });

  it("labels an under-twenty-percent background route as budget_low", () => {
    expect(routeModel({ ...base, budgetRemainingUsd: 19 })).toEqual({ provider: "freellm", model: "free-small", reason: "budget_low" });
    expect(routeModel({ ...base, budgetRemainingUsd: 20 })).toEqual({ provider: "freellm", model: "free-small", reason: "background" });
  });

  it("is byte-for-byte compatible with normal defaults when no background route is configured", () => {
    expect(routeModel({ ...base, cheap: { provider: null, model: null } }))
      .toEqual({ provider: "gemini", model: "gemini-default", reason: "default" });
  });
});
