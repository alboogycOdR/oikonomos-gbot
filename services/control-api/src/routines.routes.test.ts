import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Routine } from "@oikonomos/db";
import { buildApp } from "./app.js";
import type { ControlApiDeps } from "./ports.js";

const token = "task-182-token";
const headers = { authorization: `Bearer ${token}` };
const routine = (overrides: Partial<Routine> = {}): Routine => ({ routineId: randomUUID(), roleId: "role", tenantId: "basileia", name: "Daily", schedule: "0 8 * * *", lane: "background", enabled: true, definition: {}, lastFireAt: null, nextFireAt: null, lastFireStatus: null, skillId: null, onMissingSource: "report_and_stop", notifyThreshold: "changes_only", paused: false, ...overrides });

function deps(overrides: Partial<ControlApiDeps>): ControlApiDeps {
  return {
    createRoutine: async () => routine(), listRoutines: async () => [], setRoutinePaused: async () => routine(), testRunRoutine: async () => routine(),
    ...overrides,
  } as ControlApiDeps;
}

describe("Routine parity routes (TASK-182)", () => {
  it("pauses, resumes, and dispatches an explicit real-work test run", async () => {
    const calls: Array<[string, boolean?]> = [];
    const app = buildApp(deps({
      setRoutinePaused: async (id, tenantId, paused) => { calls.push([`${id}:${tenantId}`, paused]); return routine({ routineId: id, paused }); },
      testRunRoutine: async (id, tenantId) => { calls.push([`${id}:${tenantId}`]); return routine({ routineId: id }); },
    }), { authToken: token, logger: false });
    const id = randomUUID();
    expect((await app.inject({ method: "POST", url: `/routines/${id}/pause`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/routines/${id}/resume`, headers })).statusCode).toBe(200);
    const testRun = await app.inject({ method: "POST", url: `/routines/${id}/test-run`, headers });
    expect(testRun.statusCode).toBe(202);
    expect(JSON.parse(testRun.body)).toMatchObject({ warning: "test run performs real work" });
    expect(calls).toEqual([[`${id}:basileia`, true], [`${id}:basileia`, false], [`${id}:basileia`]]);
    await app.close();
  });

  it("returns 409 from the server-side 50-routine cap", async () => {
    const { RoutineLimitError } = await import("@oikonomos/db");
    const app = buildApp(deps({ createRoutine: async () => { throw new RoutineLimitError(); } }), { authToken: token, logger: false });
    const response = await app.inject({ method: "POST", url: "/roles/role/routines", headers, payload: { name: "n", schedule: "0 8 * * *" } });
    expect(response.statusCode).toBe(409);
    await app.close();
  });
});
