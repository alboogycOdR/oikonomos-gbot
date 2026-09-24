import { describe, expect, it, vi } from "vitest";

import { buildApp, type AutoReviewPort } from "./app.js";
import { buildSessionCookie, createSessionToken } from "./auth.js";
import type { ControlApiDeps } from "./ports.js";

const TOKEN = "task-350-token";
const ROLE_ID = "role-a";
const rule = {
  ruleId: "11111111-1111-1111-1111-111111111111", tenantId: "tenant-a", roleId: ROLE_ID,
  capabilityId: "shell.exec", targetPredicate: {}, enabled: true, createdBy: "auto-review", createdAt: new Date(),
};

function appWith(port: Partial<AutoReviewPort> = {}) {
  const autoReview: AutoReviewPort = {
    listRules: vi.fn(async () => [rule]),
    setEnabled: vi.fn(async () => [rule]),
    createRule: vi.fn(async () => ({ ...rule, createdBy: "manual" })),
    disableRule: vi.fn(async () => rule),
    ...port,
  };
  const deps = {
    listRoles: async ({ tenantId }: { tenantId: string }) => tenantId === "tenant-a" ? [{ roleId: ROLE_ID }] : [],
    listRoleGrants: async () => [{ roleId: ROLE_ID, capabilityId: "shell.exec", maxTier: "T1_draft", constraints: {} }],
  } as unknown as ControlApiDeps;
  return { app: buildApp(deps, { authToken: TOKEN, logger: false, autoReview }), autoReview };
}

const auth = { cookie: buildSessionCookie(createSessionToken(TOKEN, "tenant-a")) };

describe("TASK-350 auto-review routes", () => {
  it("gets, toggles, lists, creates and disables only through the supplied port", async () => {
    const { app, autoReview } = appWith();
    try {
      expect((await app.inject({ method: "GET", url: `/roles/${ROLE_ID}/auto-review`, headers: auth })).json()).toMatchObject({ enabled: true, rules: [{ createdBy: "auto-review" }] });
      expect((await app.inject({ method: "PUT", url: `/roles/${ROLE_ID}/auto-review`, headers: auth, payload: { enabled: false } })).statusCode).toBe(200);
      expect(autoReview.setEnabled).toHaveBeenCalledWith({ tenantId: "tenant-a", roleId: ROLE_ID, enabled: false });
      expect((await app.inject({ method: "GET", url: `/roles/${ROLE_ID}/review-rules`, headers: auth })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/roles/${ROLE_ID}/review-rules`, headers: auth, payload: { capabilityId: "shell.exec" } })).statusCode).toBe(201);
      expect((await app.inject({ method: "DELETE", url: `/roles/${ROLE_ID}/review-rules/${rule.ruleId}`, headers: auth })).statusCode).toBe(204);
    } finally { await app.close(); }
  });

  it("refuses every new route for a role outside the authenticated tenant", async () => {
    const { app, autoReview } = appWith();
    try {
      expect((await app.inject({ method: "GET", url: "/roles/other/auto-review", headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: "PUT", url: "/roles/other/auto-review", headers: auth, payload: { enabled: true } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/roles/other/review-rules", headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/roles/other/review-rules", headers: auth, payload: { capabilityId: "shell.exec" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/roles/other/review-rules/${rule.ruleId}`, headers: auth })).statusCode).toBe(404);
      expect(autoReview.listRules).toHaveBeenCalledTimes(0);
    } finally { await app.close(); }
  });
});
