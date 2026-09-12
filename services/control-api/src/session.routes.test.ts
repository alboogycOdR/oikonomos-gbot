import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createSessionToken } from "./auth.js";
import type { ControlApiDeps } from "./ports.js";

const SECRET = "session-route-test-secret";

describe("session routes (TASK-237)", () => {
  it("reports a service or user principal and rejects missing, expired, and tampered cookies", async () => {
    const app = buildApp({} as ControlApiDeps, { authToken: SECRET, logger: false });
    try {
      const service = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${SECRET}` } });
      expect(service.statusCode).toBe(200);
      expect(service.json()).toEqual({ tenantId: "basileia", kind: "service", expiresAt: null });

      const login = await app.inject({ method: "POST", url: "/auth/login", payload: { token: SECRET } });
      const cookie = login.headers["set-cookie"]!;
      const user = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
      expect(user.statusCode).toBe(200);
      expect(user.json()).toMatchObject({ tenantId: "basileia", kind: "user" });
      expect(Date.parse(user.json().expiresAt)).not.toBeNaN();

      expect((await app.inject({ method: "GET", url: "/auth/me" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: "control_api_session=tampered" } })).statusCode).toBe(401);
      const expired = createSessionToken(SECRET, 0);
      expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: `control_api_session=${expired}` } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("clears and revokes the current session", async () => {
    const app = buildApp({} as ControlApiDeps, { authToken: SECRET, logger: false });
    try {
      const login = await app.inject({ method: "POST", url: "/auth/login", payload: { token: SECRET } });
      const cookie = login.headers["set-cookie"]!;
      const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
      expect(logout.statusCode).toBe(204);
      expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
      expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
