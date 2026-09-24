import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { buildSessionCookie, createSessionToken } from "./auth.js";
import type { ControlApiDeps } from "./ports.js";

const TOKEN = "task-333-token";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const THREAD_A = "11111111-1111-1111-1111-111111111111";
const THREAD_B = "22222222-2222-2222-2222-222222222222";

function headers(tenantId: string): { cookie: string } {
  return { cookie: buildSessionCookie(createSessionToken(TOKEN, tenantId)) };
}

function deps(overrides: Record<string, unknown> = {}): ControlApiDeps {
  const roles = {
    [TENANT_A]: [{ roleId: "role-a", tenantId: TENANT_A, status: "active" }],
    [TENANT_B]: [{ roleId: "role-b", tenantId: TENANT_B, status: "active" }],
  };
  return {
    listRoles: async ({ tenantId }: { tenantId: string }) => roles[tenantId as keyof typeof roles] ?? [],
    listAllThreadsWithMembers: async () => [
      { id: THREAD_A, roleId: "role-a", title: null, createdAt: new Date(), updatedAt: new Date() },
      { id: THREAD_B, roleId: "role-b", title: null, createdAt: new Date(), updatedAt: new Date() },
    ],
    markThreadRead: async ({ readAt }: { readAt?: Date }) => readAt ?? new Date(),
    pinThread: async () => new Date(),
    unpinThread: async () => {},
    ...overrides,
  } as unknown as ControlApiDeps;
}

describe("TASK-333 thread read-marker routes", () => {
  it("marks an owned thread at an optional message time and pins/unpins it", async () => {
    const marked: Array<{ threadId: string; tenantId: string; readAt?: Date }> = [];
    const app = buildApp(deps({ markThreadRead: async (input: { threadId: string; tenantId: string; readAt?: Date }) => { marked.push(input); return input.readAt ?? new Date(); } }), { authToken: TOKEN, logger: false });
    const read = await app.inject({ method: "POST", url: `/threads/${THREAD_A}/read`, headers: headers(TENANT_A), payload: { messageAt: "2026-01-02T03:04:05.000Z" } });
    expect(read.statusCode).toBe(200);
    expect(marked).toEqual([{ threadId: THREAD_A, tenantId: TENANT_A, readAt: new Date("2026-01-02T03:04:05.000Z") }]);
    expect((await app.inject({ method: "PUT", url: `/threads/${THREAD_A}/pin`, headers: headers(TENANT_A) })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/threads/${THREAD_A}/pin`, headers: headers(TENANT_A) })).statusCode).toBe(204);
    await app.close();
  });

  it("refuses every marker route for another tenant before calling its state operation", async () => {
    const calls: string[] = [];
    const app = buildApp(deps({
      markThreadRead: async () => { calls.push("read"); return new Date(); },
      pinThread: async () => { calls.push("pin"); return new Date(); },
      unpinThread: async () => { calls.push("unpin"); },
    }), { authToken: TOKEN, logger: false });
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      const suffix = method === "POST" ? "/read" : "/pin";
      const response = await app.inject({ method, url: `/threads/${THREAD_A}${suffix}`, headers: headers(TENANT_B) });
      expect(response.statusCode).toBe(404);
    }
    expect(calls).toEqual([]);
    await app.close();
  });
});
