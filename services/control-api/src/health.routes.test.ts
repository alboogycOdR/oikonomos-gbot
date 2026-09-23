import { describe, expect, it } from "vitest";
import { type DatabaseOptions } from "@oikonomos/db";

import { buildApp } from "./app.js";
import { createDatabaseBackedDeps, type ControlApiDeps } from "./ports.js";

const TOKEN = "health-route-test-token";
const connectionString = process.env.DATABASE_URL;
const integrationIt = connectionString === undefined ? it.skip : it;

describe("GET /health/ready", () => {
  it("returns a category-only 503 when the database cannot be reached", async () => {
    const options: DatabaseOptions = {
      connectionString: "postgresql://127.0.0.1:1/oikonomos",
      poolConfig: { connectionTimeoutMillis: 100 },
    };
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "error", category: "db_unreachable" });
      expect(response.body).not.toContain("127.0.0.1");
      expect(response.body).not.toContain("postgresql:");
    } finally {
      await app.close();
    }
  });

  it("returns a timeout category without surfacing the underlying error", async () => {
    const app = buildApp({
      checkDatabaseReadiness: async () => ({ ready: false, category: "db_timeout" }),
    } as ControlApiDeps, { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "error", category: "db_timeout" });
    } finally {
      await app.close();
    }
  });

  integrationIt("uses the production database pool and leaves liveness database-free", async () => {
    const app = buildApp(createDatabaseBackedDeps({ connectionString: connectionString! }), { authToken: TOKEN, logger: false });
    try {
      const [ready, live] = await Promise.all([
        app.inject({ method: "GET", url: "/health/ready" }),
        app.inject({ method: "GET", url: "/health" }),
      ]);
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ok" });
      expect(live.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("publishes readiness in the OpenAPI document", async () => {
    const app = buildApp({ checkDatabaseReadiness: async () => ({ ready: true }) } as ControlApiDeps, { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).paths["/health/ready"].get.responses["503"]).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
