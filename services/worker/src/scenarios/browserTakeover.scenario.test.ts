import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { recordAuditEvent } from "@oikonomos/audit";
import { getAuditEventsForRun, getRun } from "@oikonomos/db";

import { createSteelGeminiTools } from "../geminiToolExecutors.js";
import { completeTaskRun, parkTaskRun, startTaskRun } from "../runLifecycle.js";
import { completeTakeover, getTakeoverState } from "../takeover.js";
import { FixtureSteelServer, cdpResult, evaluated, fixtureEndpoint, fixtureWorkspace, scenarioDatabase, steelRest } from "./scenarioHarness.js";

const allBrowserTools = [
  "mcp__steel__steel_session_create",
  "mcp__steel__steel_session_release",
  "mcp__steel__steel_navigate",
  "mcp__steel__steel_snapshot",
  "mcp__steel__steel_act",
  "mcp__steel__steel_screenshot",
];

type BrowserTool = { readonly name: string; execute(input: Record<string, unknown>): Promise<unknown> };

function tool(tools: readonly BrowserTool[], name: string): BrowserTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing browser tool ${name}`);
  return found;
}

const options = scenarioDatabase();
const integration = options === undefined ? describe.skip : describe;

integration("TASK-366 browser lane and human takeover scenarios", () => {
  let pool: Pool;
  let taskId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: options!.connectionString });
    const inserted = await pool.query<{ task_id: string }>(
      "INSERT INTO tasks (role_id, title, goal, requested_by) VALUES ($1, $2, $3, $4) RETURNING task_id",
      ["inbox-triage", "TASK-366 browser scenario", "exercise fixture browser handoff", "test:task-366"],
    );
    taskId = inserted.rows[0]!.task_id;
  });

  afterAll(async () => { await pool.end(); });

  it("(a) granted browser tools navigate, snapshot, and act on a TASK-340 element ref through the fixture Steel boundary", async () => {
    const fixture = new FixtureSteelServer([
      steelRest({ id: "steel-366", websocketUrl: "ws://steel.fixture.invalid/devtools/366" }),
      cdpResult([{ method: "Page.enable", result: {} }, { method: "Page.navigate", result: {} }, { event: "Page.loadEventFired", params: {} }, evaluated({ title: "Allowed", text: "Welcome" })]),
      steelRest({ id: "steel-366", websocketUrl: "ws://steel.fixture.invalid/devtools/366" }),
      cdpResult([{ method: "Accessibility.getFullAXTree", result: { nodes: [{ role: { value: "button" }, name: { value: "Continue" }, backendDOMNodeId: 366 }] } }, evaluated("Welcome")]),
      steelRest({ id: "steel-366", websocketUrl: "ws://steel.fixture.invalid/devtools/366" }),
      cdpResult([{ method: "DOM.resolveNode", result: {} }, evaluated({ found: true }), evaluated("Complete")]),
    ]);
    const tools = createSteelGeminiTools({ client: fixture.client(), endpoint: fixtureEndpoint, workspace: fixtureWorkspace }, allBrowserTools);

    await expect(tool(tools, "mcp__steel__steel_navigate").execute({ session_id: "steel-366", url: "https://example.com/allowed" })).resolves.toMatchObject({ ok: true, title: "Allowed" });
    await expect(tool(tools, "mcp__steel__steel_snapshot").execute({ session_id: "steel-366" })).resolves.toMatchObject({ ok: true, elements: [{ ref: "e1", name: "Continue" }] });
    await expect(tool(tools, "mcp__steel__steel_act").execute({ session_id: "steel-366", ref: "e1", action: "click" })).resolves.toEqual({ ok: true, found: true });
    expect(fixture.calls).toHaveLength(6);
    fixture.assertDrained();
  });

  it("(b) refuses loopback, private-network, metadata, and credentialed URLs before any Steel command, auditing categories only", async () => {
    const fixture = new FixtureSteelServer([]);
    const run = await startTaskRun(options!, { taskId, provider: "claude-code", sessionRef: "steel-366-denied" });
    const categories: string[] = [];
    const tools = createSteelGeminiTools({
      client: fixture.client(),
      endpoint: fixtureEndpoint,
      workspace: fixtureWorkspace,
      onNavigationDenied: async (category) => {
        categories.push(category);
        await recordAuditEvent(options!, { tenantId: run.tenantId, runId: run.runId, actor: "agent:gemini", eventType: "steel_navigation_denied", payload: { category } });
      },
    }, allBrowserTools);
    const navigate = tool(tools, "mcp__steel__steel_navigate");
    for (const [url, category] of [["http://127.0.0.1/private-token", "loopback"], ["http://10.0.0.7/", "private_network"], ["http://169.254.169.254/latest/meta-data", "metadata"], ["https://user:password@example.com/", "credentials"]]) {
      await expect(navigate.execute({ session_id: "steel-366", url })).resolves.toMatchObject({ ok: false });
      expect(categories.at(-1)).toBe(category);
    }
    // LIVENESS: removing guardNavigationTarget() from steel_navigate makes this
    // fail because the fixture receives a Steel command rather than zero calls.
    expect(fixture.calls).toEqual([]);
    expect(JSON.stringify(categories)).not.toContain("password");
    const auditPayloads = (await getAuditEventsForRun(options!, run.runId)).map((event) => event.payload);
    expect(auditPayloads).toEqual([{ category: "loopback" }, { category: "private_network" }, { category: "metadata" }, { category: "credentials" }]);
  });

  it("(c) a CAPTCHA parks the run, records a takeover request, and stops before any further browser command", async () => {
    const run = await startTaskRun(options!, { taskId, provider: "claude-code", sessionRef: "steel-366-captcha" });
    const fixture = new FixtureSteelServer([
      steelRest({ id: "steel-366", websocketUrl: "ws://steel.fixture.invalid/devtools/366" }),
      cdpResult([{ method: "Page.enable", result: {} }, { method: "Page.navigate", result: {} }, { event: "Page.loadEventFired", params: {} }, evaluated({ title: "Verify", text: "Please complete the CAPTCHA to continue" })]),
    ]);
    const onHumanTakeover = vi.fn(async (kind: string, detail: string) => {
      await recordAuditEvent(options!, { tenantId: run.tenantId, runId: run.runId, actor: "agent:gemini", eventType: "run.human_takeover_required", payload: { kind, detail } });
      await parkTaskRun(options!, run.runId);
    });
    const tools = createSteelGeminiTools({ client: fixture.client(), endpoint: fixtureEndpoint, workspace: fixtureWorkspace, onHumanTakeover }, allBrowserTools);

    await expect(tool(tools, "mcp__steel__steel_navigate").execute({ session_id: "steel-366", url: "https://example.com/challenge" })).resolves.toMatchObject({ ok: false, human_takeover_required: true, kind: "captcha", instruction: expect.stringContaining("Do not attempt to solve, bypass") });
    expect(onHumanTakeover).toHaveBeenCalledOnce();
    expect(await getTakeoverState(options!, run.runId)).toMatchObject({ pending: true, kind: "captcha" });
    expect(fixture.calls).toHaveLength(2);
    fixture.assertDrained();
    // LIVENESS: removing detectTakeover() from steel_navigate makes this fail:
    // the result becomes ok:true and no persisted takeover park exists.
  });

  it("(d) a simulated human completion resumes the parked browser run and lets it finish", async () => {
    const run = await startTaskRun(options!, { taskId, provider: "claude-code", sessionRef: "steel-366-resume" });
    await parkTaskRun(options!, run.runId);
    await recordAuditEvent(options!, { tenantId: run.tenantId, runId: run.runId, actor: "agent:gemini", eventType: "run.human_takeover_required", payload: { kind: "mfa", detail: "complete the sign-in challenge" } });

    await expect(completeTakeover(options!, run.runId)).resolves.toMatchObject({ completed: true, run: { status: "resumed" } });
    await completeTaskRun(options!, run.runId);
    expect((await getRun(options!, run.runId))?.status).toBe("completed");
    expect((await getAuditEventsForRun(options!, run.runId)).some((event) => event.eventType === "run.human_takeover_completed")).toBe(true);
  });

  it("(e) an ungranted bot cannot mount any browser tool", () => {
    const fixture = new FixtureSteelServer([]);
    expect(createSteelGeminiTools({ client: fixture.client(), endpoint: fixtureEndpoint, workspace: fixtureWorkspace }, [])).toEqual([]);
    expect(fixture.calls).toEqual([]);
  });
});
