import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type { SandboxClient, SandboxEndpoint } from "@oikonomos/sandbox-client";

import {
  createSandboxGeminiTools,
  SANDBOX_TOOL_TIMEOUT_MS,
  tierNumber,
  type SandboxToolResult,
} from "./geminiToolExecutors.js";

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
