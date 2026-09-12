import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type { ControlApiDeps } from "./ports.js";

describe("GET /workspace/summary (TASK-237)", () => {
  it("uses the authenticated tenant-scoped port and returns only its bounded projection", async () => {
    const listWorkspaceSummary = vi.fn(async () => [{
      threadId: "thread-a", latestRun: { runId: "run-a", status: "waiting_approval" as const }, pendingApprovals: 2,
      lastActivityAt: new Date("2026-09-12T10:00:00.000Z"),
    }]);
    const app = buildApp({ listWorkspaceSummary } as unknown as ControlApiDeps, { authToken: "secret", logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/workspace/summary", headers: { authorization: "Bearer secret" } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([{
        threadId: "thread-a", latestRun: { runId: "run-a", status: "waiting_approval" }, pendingApprovals: 2,
        lastActivityAt: "2026-09-12T10:00:00.000Z",
      }]);
      expect(listWorkspaceSummary).toHaveBeenCalledWith("basileia");
    } finally {
      await app.close();
    }
  });
});
