import { describe, expect, it, vi } from "vitest";

import {
  SANDBOX_HOOK_TIMEOUT_MS,
  failClosedProcessHandlers,
  runSandboxPreToolUseHook,
  type SandboxHookDependencies,
} from "./sandboxHook.js";

const environment = {
  OIK_SANDBOX_BROKER_URL: "http://broker.internal",
  OIK_SANDBOX_BROKER_TOKEN: "turn-token",
  OIK_SANDBOX_RUN_ID: "run-1",
  OIK_SANDBOX_ROLE_ID: "role-1",
  OIK_SANDBOX_TENANT_ID: "tenant-1",
  OIK_SANDBOX_AGENT_PROVIDER: "claude",
  OIK_SANDBOX_AGENT_SESSION_REF: "session-1",
};

const input = (overrides: Record<string, unknown> = {}) => ({
  session_id: "sdk-session",
  transcript_path: "/tmp/transcript",
  cwd: "/work",
  hook_event_name: "PreToolUse" as const,
  tool_name: "Bash",
  tool_input: { command: "pwd" },
  tool_use_id: "tool-1",
  ...overrides,
});

function response(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

function dependencies(fetch: typeof globalThis.fetch, overrides: Partial<SandboxHookDependencies> = {}): SandboxHookDependencies {
  return { fetch, environment, ...overrides };
}

describe("runSandboxPreToolUseHook", () => {
  it("allows a real broker allow response and passes updated input through", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ decision: "allow", toolUseId: "tool-1", updatedInput: { command: "safe" } }));
    const result = await runSandboxPreToolUseHook(input(), dependencies(fetch));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "safe" } } });
    expect(fetch).toHaveBeenCalledWith("http://broker.internal/v1/broker/pretooluse", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer turn-token" }) }));
  });

  it("maps deny and approval_pending to exit 2 with a deny payload", async () => {
    for (const body of [{ decision: "deny", reason: "policy.denied", toolUseId: "tool-1" }, { decision: "deny", reason: "approval_pending", toolUseId: "tool-1" }]) {
      const result = await runSandboxPreToolUseHook(input(), dependencies(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body))));
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe(`${body.reason}\n`);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  it("denies timeout, non-200, malformed JSON, and a mismatched tool id", async () => {
    const hanging = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    );
    await expect(runSandboxPreToolUseHook(input(), dependencies(hanging, { timeoutMs: 1 }))).resolves.toMatchObject({ exitCode: 2, stderr: "broker.timeout\n" });
    await expect(runSandboxPreToolUseHook(input(), dependencies(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({}, 503))))).resolves.toMatchObject({ exitCode: 2, stderr: "broker.http_error\n" });
    const malformed = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(runSandboxPreToolUseHook(input(), dependencies(malformed))).resolves.toMatchObject({ exitCode: 2, stderr: "broker.malformed_response\n" });
    await expect(runSandboxPreToolUseHook(input(), dependencies(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ decision: "allow", toolUseId: "other" }))))).resolves.toMatchObject({ exitCode: 2, stderr: "broker.malformed_response\n" });
  });

  it("denies locally for banned permission modes without a network call", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await runSandboxPreToolUseHook(input({ permission_mode: ["bypass", "Permissions"].join("") }), dependencies(fetch));
    expect(result).toMatchObject({ exitCode: 2, stderr: "hook.banned_permission_mode\n" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("derives isSubagent from agent_id presence for every tool name", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ decision: "allow", toolUseId: "tool-1" }));
    await runSandboxPreToolUseHook(input({ tool_name: "McpTool", agent_id: "subagent-1" }), dependencies(fetch));
    await runSandboxPreToolUseHook(input({ tool_name: "Skill" }), dependencies(fetch));
    const firstBody = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((fetch.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.agentRef.isSubagent).toBe(true);
    expect(secondBody.agentRef.isSubagent).toBe(false);
  });

  it("keeps the documented production timeout at ten seconds", () => {
    expect(SANDBOX_HOOK_TIMEOUT_MS).toBe(10_000);
  });

  it("forces exit 2 for uncaught exceptions and unhandled rejections", () => {
    const exit = vi.fn<() => never>(() => { throw new Error("test exit"); });
    const handlers = failClosedProcessHandlers(exit);
    expect(handlers.uncaughtException).toThrow("test exit");
    expect(handlers.unhandledRejection).toThrow("test exit");
    expect(exit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenNthCalledWith(1, 2);
    expect(exit).toHaveBeenNthCalledWith(2, 2);
  });
});
