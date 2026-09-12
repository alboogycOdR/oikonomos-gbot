import { randomUUID } from "node:crypto";

import { createSessionToken, buildSessionCookie } from "./auth.js";
import { buildApp } from "./app.js";
import type { ControlApiDeps } from "./ports.js";
import type { RunReceipt } from "@oikonomos/db";
import { describe, expect, it } from "vitest";

const TOKEN = "task-242-receipt-token";
const TENANT_A = "task-242-tenant-a";
const TENANT_B = "task-242-tenant-b";

function sessionHeaders(tenantId: string): { cookie: string } {
  return { cookie: buildSessionCookie(createSessionToken(TOKEN, tenantId)) };
}

function receipt(runId: string): RunReceipt {
  return {
    run: { runId, status: "completed", startedAt: new Date("2026-09-12T10:00:00Z"), endedAt: new Date("2026-09-12T10:01:00Z"), failureNote: null },
    finalMessage: { id: randomUUID(), body: "Completed report", createdAt: new Date("2026-09-12T10:00:30Z") },
    actions: [{ capability: "email.send", tier: "T3_external", verdict: "allow", reason: null }],
    approvals: [],
    unresolvedApprovals: [],
    spend: { kind: "actual", costUsd: 0.012, tokens: 123 },
  };
}

describe("GET /runs/:id/receipt (TASK-242)", () => {
  it("returns the complete receipt only for the owning tenant", async () => {
    const runId = randomUUID();
    const calls: Array<{ runId: string; tenantId: string }> = [];
    const deps = {
      getRunReceipt: async (requestedRunId: string, tenantId: string) => {
        calls.push({ runId: requestedRunId, tenantId });
        return tenantId === TENANT_A ? receipt(requestedRunId) : null;
      },
    } as ControlApiDeps;
    const app = buildApp(deps, { authToken: TOKEN, logger: false });

    const own = await app.inject({ method: "GET", url: `/runs/${runId}/receipt`, headers: sessionHeaders(TENANT_A) });
    expect(own.statusCode).toBe(200);
    expect(JSON.parse(own.body)).toMatchObject({
      run: { runId, status: "completed" },
      finalMessage: { body: "Completed report" },
      actions: [{ capability: "email.send", verdict: "allow" }],
      spend: { kind: "actual", costUsd: 0.012, tokens: 123 },
    });

    const foreign = await app.inject({ method: "GET", url: `/runs/${runId}/receipt`, headers: sessionHeaders(TENANT_B) });
    expect(foreign.statusCode).toBe(404);
    expect(JSON.parse(foreign.body)).toEqual({ error: "run not found" });
    expect(calls).toEqual([{ runId, tenantId: TENANT_A }, { runId, tenantId: TENANT_B }]);
    await app.close();
  });
});
