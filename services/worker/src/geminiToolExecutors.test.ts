import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createProjectWithRoster, createRole, defaultPoolConfig, getRole, listMessages, type DatabaseOptions } from "@oikonomos/db";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { SandboxClient, SandboxEndpoint } from "@oikonomos/sandbox-client";

import {
  createSandboxGeminiTools,
  createSteelGeminiTools,
  createWorkspaceGeminiTools,
  SANDBOX_TOOL_TIMEOUT_MS,
  tierNumber,
  type SandboxToolResult,
} from "./geminiToolExecutors.js";

const connectionString = process.env.DATABASE_URL;

const ALL_STEEL_TOOL_NAMES = [
  "mcp__steel__steel_session_create",
  "mcp__steel__steel_session_release",
  "mcp__steel__steel_navigate",
  "mcp__steel__steel_snapshot",
  "mcp__steel__steel_act",
  "mcp__steel__steel_screenshot",
];

/** A CDP command's response, in the shape runSteelCdp's runner script prints. */
function cdpStdout(results: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ results });
}

function evalResultStep(value: unknown): Record<string, unknown> {
  return { method: "Runtime.evaluate", result: { result: { value } } };
}

const endpoint: SandboxEndpoint = { endpoint: "http://execd.test/211" };
const workspace = "/workspace/role-211";

function fakeClient(
  runCommand: SandboxClient["runCommand"] = vi.fn(async () => ({ stdout: "out", stderr: "", exitCode: 0 })),
): { client: SandboxClient; runCommand: SandboxClient["runCommand"] } {
  return { client: { runCommand } as unknown as SandboxClient, runCommand };
}

function toolNamed(tools: readonly { name: string }[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool as { name: string; tier: number; execute(a: Record<string, unknown>): Promise<unknown> };
}

describe("createSandboxGeminiTools — Gemini lane isolation (TASK-211)", () => {
  it("executes every tool inside the role's sandbox, never in the worker process", async () => {
    const { client, runCommand } = fakeClient();
    const tools = createSandboxGeminiTools({ client, endpoint, workspace });

    await toolNamed(tools, "Read").execute({ file_path: "notes.md" });
    await toolNamed(tools, "Bash").execute({ command: "echo hi" });

    expect(runCommand).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(runCommand).mock.calls) {
      expect(call[0]).toEqual(endpoint);
      // Nothing of the worker's own environment may reach a bot's tool.
      expect(call[1]).toMatchObject({ cwd: workspace, envs: {}, timeoutMs: SANDBOX_TOOL_TIMEOUT_MS });
    }
  });

  it("quotes a path so a crafted filename cannot break out of the command", async () => {
    const { client, runCommand } = fakeClient();
    const tools = createSandboxGeminiTools({ client, endpoint, workspace });

    await toolNamed(tools, "Read").execute({ file_path: "a'; rm -rf /; echo '" });

    const command = vi.mocked(runCommand).mock.calls[0]?.[1].command ?? "";
    expect(command.startsWith("cat -- '")).toBe(true);
    // The injected quote is escaped, so the payload stays one argument.
    expect(command).toContain("'\\''");
  });

  it("tiers tools honestly, so the adapter's Stage-1 ceiling still refuses Bash", () => {
    const { client } = fakeClient();
    const tools = createSandboxGeminiTools({ client, endpoint, workspace });

    // STAGE_ONE_MAXIMUM_TOOL_TIER is 0. Read is genuinely T0; Bash is
    // genuinely T3. Flattening Bash to 0 to get it past the ceiling would
    // have silently defeated the control ADR-011 §3 put there.
    expect(toolNamed(tools, "Read").tier).toBe(tierNumber("T0_observe"));
    expect(toolNamed(tools, "Bash").tier).toBe(tierNumber("T3_external"));
    expect(toolNamed(tools, "Bash").tier).toBeGreaterThan(0);
  });

  it("returns a non-zero exit to the model as a result, not as a thrown run failure", async () => {
    const { client } = fakeClient(vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 2 })));
    const tools = createSandboxGeminiTools({ client, endpoint, workspace });

    const result = (await toolNamed(tools, "Bash").execute({ command: "false" })) as SandboxToolResult;
    expect(result).toMatchObject({ ok: false, exitCode: 2, stderr: "boom" });
  });

  it("surfaces an unreachable sandbox as a tool error without leaking transport detail", async () => {
    const { client } = fakeClient(vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:44772 token=super-secret");
    }));
    const tools = createSandboxGeminiTools({ client, endpoint, workspace });

    const result = (await toolNamed(tools, "Bash").execute({ command: "echo hi" })) as SandboxToolResult;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("44772");
  });

  it("rejects a malformed argument rather than shipping it to a shell", async () => {
    const { client, runCommand } = fakeClient();
    const tools = createSandboxGeminiTools({ client, endpoint, workspace });

    await expect(toolNamed(tools, "Bash").execute({})).rejects.toThrow(/command/);
    await expect(toolNamed(tools, "Read").execute({ file_path: "   " })).rejects.toThrow(/file_path/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("constructs inertly, so nothing runs before the broker decision does", async () => {
    // ADR-011 §2.2: the adapter awaits l1.handle() immediately before
    // execute(). An executor that warmed anything at construction would run
    // it ahead of that decision.
    const { runCommand } = fakeClient();
    createSandboxGeminiTools({ client: { runCommand } as unknown as SandboxClient, endpoint, workspace });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("LIVENESS: a client that always fails must fail every tool — proving execution really goes through it", async () => {
    // ADR-005, keyed on behaviour rather than on config or a source string.
    // If execution ever silently fell back to running locally in the worker,
    // these calls would SUCCEED despite a totally broken sandbox client, and
    // this test goes red. That is the failure mode the whole task exists to
    // prevent, so it must be observable.
    const { client } = fakeClient(vi.fn(async () => {
      throw new Error("sandbox is gone");
    }));
    const tools = createSandboxGeminiTools({ client, endpoint, workspace });

    for (const tool of tools) {
      const result = (await tool.execute(
        tool.name === "Read" ? { file_path: "notes.md" } : { command: "echo hi" },
      )) as SandboxToolResult;
      expect(result.ok).toBe(false);
    }

    // Belt and braces: no local execution primitive is reachable from this
    // module at all.
    const source = readFileSync(fileURLToPath(new URL("./geminiToolExecutors.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("node:child_process");
    expect(source).toContain("client.runCommand(");
  });
});

function restStdout(json: unknown, status = 200): string {
  return `${JSON.stringify(json)}\n${status}`;
}

describe("createSteelGeminiTools — Steel Browser tools for the Gemini lane (TASK-225)", () => {
  it("only mounts tools the role's grants actually cover", () => {
    const { client } = fakeClient();
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ["mcp__steel__steel_session_create"]);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__steel__steel_session_create"]);
  });

  it("mounts nothing when the role holds no browser grants", () => {
    const { client } = fakeClient();
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, []);
    expect(tools).toHaveLength(0);
  });

  it("tiers every tool honestly — all clear the Stage-2 ceiling (STAGE_TWO_MAXIMUM_TOOL_TIER = 2) by construction", () => {
    const { client } = fakeClient();
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);
    expect(toolNamed(tools, "mcp__steel__steel_session_create").tier).toBe(tierNumber("T1_draft"));
    expect(toolNamed(tools, "mcp__steel__steel_session_release").tier).toBe(tierNumber("T1_draft"));
    expect(toolNamed(tools, "mcp__steel__steel_navigate").tier).toBe(tierNumber("T1_draft"));
    expect(toolNamed(tools, "mcp__steel__steel_snapshot").tier).toBe(tierNumber("T0_observe"));
    expect(toolNamed(tools, "mcp__steel__steel_act").tier).toBe(tierNumber("T2_internal"));
    expect(toolNamed(tools, "mcp__steel__steel_screenshot").tier).toBe(tierNumber("T0_observe"));
    for (const tool of tools) expect(tool.tier).toBeLessThanOrEqual(2);
  });

  it("session_create POSTs /v1/sessions and returns the session id", async () => {
    const runCommand = vi.fn<SandboxClient["runCommand"]>(async () => ({ stdout: restStdout({ id: "sess-1", status: "live" }), stderr: "", exitCode: 0 }));
    const { client } = fakeClient(runCommand);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    const result = await toolNamed(tools, "mcp__steel__steel_session_create").execute({});
    expect(result).toMatchObject({ ok: true, session_id: "sess-1" });
    const command = vi.mocked(runCommand).mock.calls[0]?.[1].command ?? "";
    expect(command).toContain("http://127.0.0.1:3000/v1/sessions");
    expect(command).toContain("-X POST");
  });

  // TASK-214's live proof caught this for real: a genuinely successful
  // Steel session create was misread as a failure. `runCommand`'s stdout is
  // assembled from separately-streamed execd chunks (packages/sandbox-client,
  // plain `+=` concatenation) — a live run showed curl's trailing "\n200"
  // can arrive split from the JSON body's own chunk in a way that loses the
  // newline between them by the time this code sees the joined string.
  // Reproduces that exact shape (no newline at all between body and status)
  // rather than trusting the `restStdout` helper's always-clean `\n`.
  it("still recognizes a real success when the body/status newline did not survive concatenation (TASK-214 live-bug regression)", async () => {
    const runCommand = vi.fn<SandboxClient["runCommand"]>(async () => ({
      stdout: `${JSON.stringify({ id: "sess-live", status: "live" })}200`,
      stderr: "",
      exitCode: 0,
    }));
    const { client } = fakeClient(runCommand);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    const result = await toolNamed(tools, "mcp__steel__steel_session_create").execute({});
    expect(result).toMatchObject({ ok: true, session_id: "sess-live" });
  });

  it("session_release POSTs /v1/sessions/{id}/release", async () => {
    const runCommand = vi.fn<SandboxClient["runCommand"]>(async () => ({ stdout: restStdout({}, 200), stderr: "", exitCode: 0 }));
    const { client } = fakeClient(runCommand);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    const result = await toolNamed(tools, "mcp__steel__steel_session_release").execute({ session_id: "sess-1" });
    expect(result).toEqual({ ok: true });
    const command = vi.mocked(runCommand).mock.calls[0]?.[1].command ?? "";
    expect(command).toContain("http://127.0.0.1:3000/v1/sessions/sess-1/release");
  });

  it("navigate fetches a FRESH websocketUrl (never a cached one) before every CDP connection, then runs the CDP script", async () => {
    const runCommand = vi
      .fn<SandboxClient["runCommand"]>()
      .mockResolvedValueOnce({ stdout: restStdout({ id: "sess-1", websocketUrl: "ws://127.0.0.1:3000/devtools/1" }), stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: cdpStdout([
          { method: "Page.enable", result: {} },
          { method: "Page.navigate", result: {} },
          { event: "Page.loadEventFired", params: {} },
          evalResultStep({ title: "Example", text: "hello world" }),
        ]),
        stderr: "",
        exitCode: 0,
      });
    const { client } = fakeClient(runCommand);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    const result = await toolNamed(tools, "mcp__steel__steel_navigate").execute({ session_id: "sess-1", url: "https://example.com" });
    expect(result).toMatchObject({ ok: true, url: "https://example.com", title: "Example" });

    const calls = vi.mocked(runCommand).mock.calls;
    expect(calls[0]?.[1].command).toContain("/v1/sessions/sess-1");
    expect(calls[0]?.[1].command).not.toContain("/release");
    expect(calls[1]?.[1].command.startsWith("node -e")).toBe(true);
    // The payload (including the websocketUrl) is base64-encoded specifically to
    // avoid shell-quoting it, so it won't appear as a literal substring here —
    // the tool's own returned result (asserted above) is what proves the fresh
    // URL actually round-tripped through the CDP call correctly.
  });

  it("refuses an internal navigation before CDP and persists only its category (TASK-325 liveness)", async () => {
    const runCommand = vi.fn<SandboxClient["runCommand"]>();
    const onNavigationDenied = vi.fn();
    const { client } = fakeClient(runCommand);
    const tools = createSteelGeminiTools({ client, endpoint, workspace, onNavigationDenied }, ALL_STEEL_TOOL_NAMES);

    const result = await toolNamed(tools, "mcp__steel__steel_navigate").execute({
      session_id: "sess-1",
      url: "http://169.254.169.254/latest/meta-data?token=never-audit-this",
    });

    expect(result).toEqual({ ok: false, error: "I can’t navigate to that address because it targets a restricted network location." });
    // Mutation-proof: bypassing the executor guard causes this category-only
    // refusal evidence to disappear and this assertion to fail.
    expect(onNavigationDenied).toHaveBeenCalledExactlyOnceWith("metadata");
    expect(runCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(onNavigationDenied.mock.calls)).not.toContain("token=");
  });

  it("detects a human-takeover page during navigate, fires onHumanTakeover, and tells the model to stop — never a generic tool error", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: restStdout({ id: "sess-1", websocketUrl: "ws://127.0.0.1:3000/devtools/1" }), stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: cdpStdout([
          { method: "Page.enable", result: {} },
          { method: "Page.navigate", result: {} },
          { event: "Page.loadEventFired", params: {} },
          evalResultStep({ title: "Verify", text: "Please complete the CAPTCHA to continue" }),
        ]),
        stderr: "",
        exitCode: 0,
      });
    const { client } = fakeClient(runCommand as unknown as SandboxClient["runCommand"]);
    const onHumanTakeover = vi.fn();
    const tools = createSteelGeminiTools({ client, endpoint, workspace, onHumanTakeover }, ALL_STEEL_TOOL_NAMES);

    const result = await toolNamed(tools, "mcp__steel__steel_navigate").execute({ session_id: "sess-1", url: "https://example.com" });
    expect(result).toMatchObject({ ok: false, human_takeover_required: true, kind: "captcha" });
    expect(onHumanTakeover).toHaveBeenCalledWith("captcha", expect.stringContaining("captcha"));
  });

  it("snapshot returns the accessibility tree and visible text, mutation-proven: a broken takeover check would let a CAPTCHA page through as ok:true", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: restStdout({ id: "sess-1", websocketUrl: "ws://127.0.0.1:3000/devtools/1" }), stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: cdpStdout([
          { method: "Accessibility.getFullAXTree", result: { nodes: [{ role: "button", name: "Submit" }] } },
          evalResultStep("Welcome to the dashboard"),
        ]),
        stderr: "",
        exitCode: 0,
      });
    const { client } = fakeClient(runCommand as unknown as SandboxClient["runCommand"]);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    const result = await toolNamed(tools, "mcp__steel__steel_snapshot").execute({ session_id: "sess-1" });
    expect(result).toMatchObject({ ok: true, accessibility_tree: [{ role: "button", name: "Submit" }], visible_text: "Welcome to the dashboard" });
  });

  it("act clicks/types via the CDP script and reports whether the selector was found", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: restStdout({ id: "sess-1", websocketUrl: "ws://127.0.0.1:3000/devtools/1" }), stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: cdpStdout([evalResultStep({ found: true }), evalResultStep("after click")]),
        stderr: "",
        exitCode: 0,
      });
    const { client } = fakeClient(runCommand as unknown as SandboxClient["runCommand"]);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    const result = await toolNamed(tools, "mcp__steel__steel_act").execute({ session_id: "sess-1", selector: "#submit", action: "click" });
    expect(result).toEqual({ ok: true, found: true });
  });

  it("TASK-340: snapshot lists only allow-listed roles as e1.. refs, capped at 200", async () => {
    const nodes: Record<string, unknown>[] = [
      { role: { value: "heading" }, name: { value: "Title" }, backendDOMNodeId: 1 },
      { role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 2, properties: [{ name: "disabled", value: { value: true } }, { name: "level", value: { value: 3 } }] },
      { role: { value: "link" }, name: { value: "Ignored" }, backendDOMNodeId: 3, ignored: true },
      { role: { value: "textbox" }, name: { value: "Email" }, backendDOMNodeId: 4 },
      ...Array.from({ length: 250 }, (_, i) => ({ role: { value: "link" }, name: { value: `l${i}` }, backendDOMNodeId: 100 + i })),
    ];
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: restStdout({ id: "sess-1", websocketUrl: "ws://127.0.0.1:3000/devtools/1" }), stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: cdpStdout([{ method: "Accessibility.getFullAXTree", result: { nodes } }, evalResultStep("Page")]), stderr: "", exitCode: 0 });
    const { client } = fakeClient(runCommand as unknown as SandboxClient["runCommand"]);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    const result = (await toolNamed(tools, "mcp__steel__steel_snapshot").execute({ session_id: "sess-1" })) as {
      elements: { ref: string; role: string; name: string; state: Record<string, unknown> }[];
      elements_truncated?: boolean;
    };
    expect(result.elements).toHaveLength(200);
    expect(result.elements_truncated).toBe(true);
    expect(result.elements[0]).toEqual({ ref: "e1", role: "button", name: "Save", state: { disabled: true } });
    expect(result.elements[1]).toMatchObject({ ref: "e2", role: "textbox", name: "Email" });
    expect(result.elements.some((e) => e.role === "heading")).toBe(false);
  });

  it("TASK-340: acting by ref targets that element's backend node; a stale or unknown ref is refused", async () => {
    const sessionRest = { stdout: restStdout({ id: "sess-1", websocketUrl: "ws://127.0.0.1:3000/devtools/1" }), stderr: "", exitCode: 0 };
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(sessionRest)
      .mockResolvedValueOnce({
        stdout: cdpStdout([
          { method: "Accessibility.getFullAXTree", result: { nodes: [
            { role: { value: "button" }, name: { value: "A" }, backendDOMNodeId: 11 },
            { role: { value: "button" }, name: { value: "B" }, backendDOMNodeId: 22 },
          ] } },
          evalResultStep("Page"),
        ]),
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce(sessionRest)
      .mockResolvedValueOnce({ stdout: cdpStdout([{ method: "DOM.resolveNode", result: {} }, evalResultStep({ found: true }), evalResultStep("after")]), stderr: "", exitCode: 0 })
      .mockResolvedValueOnce(sessionRest)
      .mockResolvedValueOnce({ stdout: "", stderr: "No node with given id found", exitCode: 1 });
    const { client } = fakeClient(runCommand as unknown as SandboxClient["runCommand"]);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);
    const act = toolNamed(tools, "mcp__steel__steel_act");

    // Unknown before any snapshot: refused without touching the browser.
    expect(await act.execute({ session_id: "sess-1", ref: "e1", action: "click" })).toMatchObject({ ok: false, error: expect.stringContaining("snapshot") });
    expect(runCommand).not.toHaveBeenCalled();

    await toolNamed(tools, "mcp__steel__steel_snapshot").execute({ session_id: "sess-1" });
    expect(await act.execute({ session_id: "sess-1", ref: "e2", action: "click" })).toEqual({ ok: true, found: true });
    const actCommand = String((runCommand.mock.calls[3] as unknown as [unknown, { command: string }])[1].command);
    const sent = Buffer.from(/'([A-Za-z0-9+/=]{20,})'$/.exec(actCommand)?.[1] ?? "", "base64").toString("utf8");
    expect(sent).toContain('"backendNodeId":22');
    expect(sent).toContain('"objectIdFromStep":0');

    const stale = await act.execute({ session_id: "sess-1", ref: "e1", action: "click" });
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/no longer valid/) });
    // Stale ref dropped: the next use is unknown, not guessed.
    expect(await act.execute({ session_id: "sess-1", ref: "e1", action: "click" })).toMatchObject({ ok: false, error: expect.stringContaining("Take a snapshot") });
    expect(await act.execute({ session_id: "sess-1", ref: "e99", action: "click" })).toMatchObject({ ok: false });
  });

  it("TASK-340: navigating invalidates refs from earlier snapshots", async () => {
    const sessionRest = { stdout: restStdout({ id: "sess-1", websocketUrl: "ws://127.0.0.1:3000/devtools/1" }), stderr: "", exitCode: 0 };
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(sessionRest)
      .mockResolvedValueOnce({ stdout: cdpStdout([{ method: "Accessibility.getFullAXTree", result: { nodes: [{ role: { value: "button" }, name: { value: "A" }, backendDOMNodeId: 5 }] } }, evalResultStep("Page")]), stderr: "", exitCode: 0 })
      .mockResolvedValueOnce(sessionRest)
      .mockResolvedValueOnce({ stdout: cdpStdout([{}, {}, {}, evalResultStep({ title: "t", text: "hello" })]), stderr: "", exitCode: 0 });
    const { client } = fakeClient(runCommand as unknown as SandboxClient["runCommand"]);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);
    await toolNamed(tools, "mcp__steel__steel_snapshot").execute({ session_id: "sess-1" });
    await toolNamed(tools, "mcp__steel__steel_navigate").execute({ session_id: "sess-1", url: "https://example.com" });
    const calls = runCommand.mock.calls.length;
    expect(await toolNamed(tools, "mcp__steel__steel_act").execute({ session_id: "sess-1", ref: "e1", action: "click" })).toMatchObject({ ok: false });
    expect(runCommand.mock.calls.length).toBe(calls);
  });

  it("act requires 'text' for type/fill but not for click", async () => {
    const { client } = fakeClient();
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    await expect(
      toolNamed(tools, "mcp__steel__steel_act").execute({ session_id: "sess-1", selector: "#x", action: "type" }),
    ).rejects.toThrow(/text/);
  });

  it("screenshot returns a base64 PNG from Page.captureScreenshot", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: restStdout({ id: "sess-1", websocketUrl: "ws://127.0.0.1:3000/devtools/1" }), stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: cdpStdout([{ method: "Page.captureScreenshot", result: { data: "aGVsbG8=" } }]),
        stderr: "",
        exitCode: 0,
      });
    const { client } = fakeClient(runCommand as unknown as SandboxClient["runCommand"]);
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    const result = await toolNamed(tools, "mcp__steel__steel_screenshot").execute({ session_id: "sess-1" });
    expect(result).toEqual({ ok: true, image_base64: "aGVsbG8=" });
  });

  it("LIVENESS: an unreachable sandbox fails every Steel tool as a result, not a thrown run failure", async () => {
    const { client } = fakeClient(vi.fn(async () => {
      throw new Error("sandbox is gone");
    }));
    const tools = createSteelGeminiTools({ client, endpoint, workspace }, ALL_STEEL_TOOL_NAMES);

    for (const tool of tools) {
      const arguments_ = tool.name === "mcp__steel__steel_session_create"
        ? {}
        : tool.name === "mcp__steel__steel_act"
          ? { session_id: "sess-1", selector: "#x", action: "click" }
          : { session_id: "sess-1", url: "https://example.com" };
      const result = (await tool.execute(arguments_)) as { ok: boolean };
      expect(result.ok).toBe(false);
    }
  });
});

describe("createWorkspaceGeminiTools — deliberately NOT sandboxed, unlike every tool above", () => {
  it("advertises all project handoff kinds through the Gemini executor schema", () => {
    const tools = createWorkspaceGeminiTools(
      { connectionString: "unused", tenantId: "basileia", roleId: "role-1" },
      ["mcp__workspace__send_to_role"],
    );
    const tool = tools.find((candidate) => candidate.name === "mcp__workspace__send_to_role");
    expect((tool?.parameters as { properties: { handoffKind: { enum: readonly string[] } } }).properties.handoffKind.enum).toEqual([
      "research.complete", "draft.ready_for_review", "task.assigned", "task.completed", "task.blocked", "status.requested",
    ]);
  });

  (connectionString === undefined ? it.skip : it)("passes its worker-bound run ID to idempotent send_to_role", async () => {
    const fromRoleId = "task-328-gemini-from";
    const toRoleId = "task-328-gemini-to";
    const pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    try {
      await pool.query("DELETE FROM role_messages WHERE from_role_id = ANY($1::text[]) OR to_role_id = ANY($1::text[])", [[fromRoleId, toRoleId]]);
      await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [[fromRoleId, toRoleId]]);
      await createRole({ connectionString: connectionString! }, { roleId: fromRoleId, name: fromRoleId, title: "TASK-328 Gemini fixture" });
      await createRole({ connectionString: connectionString! }, { roleId: toRoleId, name: toRoleId, title: "TASK-328 Gemini fixture" });
      const [tool] = createWorkspaceGeminiTools(
        { connectionString: connectionString!, tenantId: "basileia", roleId: fromRoleId, runId: crypto.randomUUID() },
        ["mcp__workspace__send_to_role"],
      );
      await tool!.execute({ toRoleId, body: "one durable handoff" });
      expect(await tool!.execute({ toRoleId, body: "one durable handoff" })).toMatchObject({ message: "already sent" });
      expect((await pool.query("SELECT 1 FROM role_messages WHERE from_role_id = $1 AND to_role_id = $2", [fromRoleId, toRoleId])).rowCount).toBe(1);
    } finally {
      await pool.query("DELETE FROM role_messages WHERE from_role_id = ANY($1::text[]) OR to_role_id = ANY($1::text[])", [[fromRoleId, toRoleId]]);
      await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [[fromRoleId, toRoleId]]);
      await pool.end();
    }
  });

  it("mounts create_routine only when granted", () => {
    const granted = createWorkspaceGeminiTools(
      { connectionString: "unused", tenantId: "basileia", roleId: "role-1" },
      ["mcp__workspace__create_routine"],
    );
    expect(granted.map((tool) => tool.name)).toEqual(["mcp__workspace__create_routine"]);

    const ungranted = createWorkspaceGeminiTools(
      { connectionString: "unused", tenantId: "basileia", roleId: "role-1" },
      [],
    );
    expect(ungranted).toEqual([]);
  });

  it("tiers create_routine honestly (T1_draft, matching packages/broker/src/builtinTools.ts)", () => {
    const [tool] = createWorkspaceGeminiTools(
      { connectionString: "unused", tenantId: "basileia", roleId: "role-1" },
      ["mcp__workspace__create_routine"],
    );
    expect(tool?.tier).toBe(tierNumber("T1_draft"));
  });

  (connectionString === undefined ? it.skip : it)(
    "creates a real routine and a real system confirmation message — same underlying write as the Claude/MCP path (real Postgres)",
    async () => {
      const options: DatabaseOptions = { connectionString: connectionString! };
      const pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
      const roleId = "gemini-create-routine-fixture";
      try {
        await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
        await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
        await pool.query("DELETE FROM role_routines WHERE role_id = $1", [roleId]);
        await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
        await pool.query(
          "INSERT INTO roles (role_id, tenant_id, name, title, description, status) VALUES ($1, 'basileia', $1, 'fixture', '', 'active')",
          [roleId],
        );
        const thread = await pool.query<{ id: string }>("INSERT INTO threads (role_id) VALUES ($1) RETURNING id", [roleId]);
        const threadId = thread.rows[0]!.id;

        const [tool] = createWorkspaceGeminiTools(
          { connectionString: connectionString!, tenantId: "basileia", roleId, threadId },
          ["mcp__workspace__create_routine"],
        );
        const result = (await tool!.execute({ name: "Gemini routine", schedule: "0 9 * * 1" })) as { name: string; description: string };
        expect(result).toMatchObject({ name: "Gemini routine", description: "every Monday at 9:00 AM" });

        const routine = await pool.query("SELECT 1 FROM role_routines WHERE role_id = $1 AND name = $2", [roleId, "Gemini routine"]);
        expect(routine.rowCount).toBe(1);
        const messages = await listMessages(options, threadId);
        expect(messages).toMatchObject([{ role: "system", body: 'New routine "Gemini routine" — every Monday at 9:00 AM' }]);
      } finally {
        await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
        await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
        await pool.query("DELETE FROM role_routines WHERE role_id = $1", [roleId]);
        await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
        await pool.end();
      }
    },
  );

  (connectionString === undefined ? it.skip : it)(
    "denies an out-of-roster target and accepts a managed-project roster member through the Gemini lane (TASK-313)",
    async () => {
      const tenantId = "task-313-gemini-lane";
      const managerRoleId = "task-313-gemini-manager";
      const allowedRoleId = "task-313-gemini-allowed";
      const outsideRoleId = "task-313-gemini-outside";
      const pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
      const options = { connectionString: connectionString! };
      try {
        await pool.query("DELETE FROM project_roles WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)", [tenantId]);
        await pool.query("DELETE FROM projects WHERE tenant_id = $1", [tenantId]);
        await pool.query("DELETE FROM thread_members WHERE role_id = ANY($1::text[])", [[managerRoleId, allowedRoleId, outsideRoleId]]);
        await pool.query("DELETE FROM threads WHERE title = 'TASK-313 Gemini lane thread'");
        await pool.query("DELETE FROM roles WHERE tenant_id = $1", [tenantId]);
        for (const roleId of [managerRoleId, allowedRoleId, outsideRoleId]) {
          await createRole(options, { roleId, tenantId, name: roleId, title: "TASK-313 Gemini fixture" });
        }
        await createProjectWithRoster(options, {
          tenantId, name: "TASK-313 Gemini project", title: "TASK-313 Gemini lane thread", goal: "scope", doneCriterion: "done", createdBy: "human:task-313",
          roster: [{ roleId: managerRoleId, isManager: true }, { roleId: allowedRoleId }],
        });

        const [tool] = createWorkspaceGeminiTools(
          { connectionString: connectionString!, tenantId, roleId: managerRoleId },
          ["mcp__workspace__retire_bot"],
        );
        const denied = await tool!.execute({ roleId: outsideRoleId });
        expect(denied).toMatchObject({ ok: false, code: "outside_managed_project", error: expect.stringContaining("project it manages") });
        expect((await getRole(options, outsideRoleId))?.status).toBe("active");

        const accepted = await tool!.execute({ roleId: allowedRoleId });
        expect(accepted).toMatchObject({ roleId: allowedRoleId, status: "hidden" });
        expect((await getRole(options, allowedRoleId))?.status).toBe("hidden");
      } finally {
        await pool.query("DELETE FROM project_roles WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)", [tenantId]);
        await pool.query("DELETE FROM projects WHERE tenant_id = $1", [tenantId]);
        await pool.query("DELETE FROM thread_members WHERE role_id = ANY($1::text[])", [[managerRoleId, allowedRoleId, outsideRoleId]]);
        await pool.query("DELETE FROM threads WHERE title = 'TASK-313 Gemini lane thread'");
        await pool.query("DELETE FROM roles WHERE tenant_id = $1", [tenantId]);
        await pool.end();
      }
    },
  );
});
