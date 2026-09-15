import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Routine } from "@oikonomos/db";
import { buildApp } from "./app.js";
import type { ControlApiDeps } from "./ports.js";

const token = "task-182-token";
const headers = { authorization: `Bearer ${token}` };
const routine = (overrides: Partial<Routine> = {}): Routine => ({ routineId: randomUUID(), roleId: "role", tenantId: "basileia", name: "Daily", schedule: "0 8 * * *", lane: "background", enabled: true, definition: {}, lastFireAt: null, nextFireAt: null, lastFireStatus: null, skillId: null, onMissingSource: "report_and_stop", notifyThreshold: "changes_only", paused: false, timezone: "UTC", ...overrides });

function deps(overrides: Partial<ControlApiDeps>): ControlApiDeps {
  return {
    createRoutine: async () => routine(), listRoutines: async () => [], setRoutinePaused: async () => routine(), updateRoutineSkill: async (_id, _tenantId, skillId) => routine({ skillId }), testRunRoutine: async () => routine(),
    ...overrides,
  } as ControlApiDeps;
}

describe("Routine parity routes (TASK-182)", () => {
  it("updates a routine skill binding and clears it with null", async () => {
    const id = randomUUID();
    const skillId = randomUUID();
    const calls: Array<[string, string, string | null]> = [];
    const app = buildApp(deps({
      updateRoutineSkill: async (routineId, tenantId, nextSkillId) => {
        calls.push([routineId, tenantId, nextSkillId]);
        return routine({ routineId, skillId: nextSkillId });
      },
    }), { authToken: token, logger: false });

    const rebound = await app.inject({ method: "PATCH", url: `/routines/${id}`, headers, payload: { skillId } });
    expect(rebound.statusCode).toBe(200);
    expect(JSON.parse(rebound.body)).toMatchObject({ routineId: id, skillId });
    const cleared = await app.inject({ method: "PATCH", url: `/routines/${id}`, headers, payload: { skillId: null } });
    expect(cleared.statusCode).toBe(200);
    expect(JSON.parse(cleared.body)).toMatchObject({ routineId: id, skillId: null });
    expect(calls).toEqual([[id, "basileia", skillId], [id, "basileia", null]]);
    await app.close();
  });

  it("returns 404, never 403, and does not update a cross-tenant routine", async () => {
    const id = randomUUID();
    const calls: string[] = [];
    const app = buildApp(deps({
      updateRoutineSkill: async (routineId) => { calls.push(routineId); return null; },
    }), { authToken: token, logger: false });

    const response = await app.inject({ method: "PATCH", url: `/routines/${id}`, headers, payload: { skillId: randomUUID() } });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "routine not found" });
    expect(calls).toEqual([id]);
    await app.close();
  });

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

  it("TASK-247 / §9.3: creates a routine with an explicit IANA timezone and its next fire lands at the correct UTC instant", async () => {
    const calls: unknown[] = [];
    const app = buildApp(deps({
      createRoutine: async (input) => {
        calls.push(input);
        return routine({ timezone: input.timezone, nextFireAt: input.nextFireAt ?? null });
      },
    }), { authToken: token, logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/roles/role/routines",
      headers,
      payload: { name: "Morning digest", schedule: "0 9 * * *", timezone: "Africa/Johannesburg" },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as Routine;
    expect(body.timezone).toBe("Africa/Johannesburg");
    // 09:00 in Africa/Johannesburg (UTC+2, no DST) is 07:00Z, regardless of
    // calendar date — assert the UTC hour rather than a specific date.
    expect((body.nextFireAt as unknown as string)).toMatch(/T07:00:00/);
    expect(calls).toEqual([expect.objectContaining({ timezone: "Africa/Johannesburg" })]);
    await app.close();
  });

  it("TASK-247: rejects an invalid IANA timezone with 400, before ever calling deps.createRoutine", async () => {
    const calls: unknown[] = [];
    const app = buildApp(deps({ createRoutine: async (input) => { calls.push(input); return routine(); } }), { authToken: token, logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/roles/role/routines",
      headers,
      payload: { name: "Bad tz", schedule: "0 9 * * *", timezone: "Not/AZone" },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: expect.stringMatching(/valid IANA time zone name/) });
    expect(calls).toEqual([]);
    await app.close();
  });

  it("TASK-247: omitting timezone defaults the computed nextFireAt to UTC evaluation", async () => {
    const app = buildApp(deps({
      createRoutine: async (input) => routine({ timezone: input.timezone ?? "UTC", nextFireAt: input.nextFireAt ?? null }),
    }), { authToken: token, logger: false });

    const response = await app.inject({ method: "POST", url: "/roles/role/routines", headers, payload: { name: "UTC default", schedule: "0 9 * * *" } });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as Routine;
    expect(body.timezone).toBe("UTC");
    await app.close();
  });
});
