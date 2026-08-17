import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bannedModeTokens,
  createHarness,
  HarnessFactoryError,
  HOOK_TIMEOUT_SECONDS,
  L2_PERMISSION_MODE,
  SUBPROCESS_TOOL_NAME,
  type AgentSdkQueryInput,
  type CanUseToolPort,
  type HarnessDeps,
  type PostToolUseHookPort,
  type PreToolUseHookPort,
} from "../src/index.js";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function readSrc(): { name: string; body: string }[] {
  return readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      body: readFileSync(join(srcDir, name), "utf8"),
    }));
}

function allowL1(): PreToolUseHookPort {
  return {
    async handle(request) {
      return { decision: "allow", updatedInput: request.input };
    },
  };
}

function denyL1(message = "denied by L1"): PreToolUseHookPort {
  return {
    async handle() {
      return { decision: "deny", message };
    },
  };
}

function allowL3(): CanUseToolPort {
  return {
    async canUseTool(request) {
      return { behavior: "allow", updatedInput: request.input };
    },
  };
}

function capturingQuery(sink: AgentSdkQueryInput[]): HarnessDeps["queryFn"] {
  return async function* capture(input) {
    sink.push(input);
  };
}

function deps(overrides: Partial<HarnessDeps> = {}): HarnessDeps {
  return {
    l1: allowL1(),
    l2: { permissionMode: L2_PERMISSION_MODE, allowedTools: ["Bash(ls *)"] },
    l3: allowL3(),
    queryFn: capturingQuery([]),
    ...overrides,
  };
}

describe("createHarness — L1/L2/L3 seams", () => {
  it("configures L1 PreToolUse, L2 dontAsk + allowedTools, and L3 canUseTool", async () => {
    const captured: AgentSdkQueryInput[] = [];
    const l1Calls: string[] = [];
    const l3Calls: string[] = [];

    const harness = createHarness({
      l1: {
        async handle(request) {
          l1Calls.push(request.toolUseId);
          return { decision: "allow", updatedInput: { ...request.input, gated: true } };
        },
      },
      l2: { permissionMode: L2_PERMISSION_MODE, allowedTools: ["Read(src/**)", "Bash(ls *)"] },
      l3: {
        async canUseTool(request) {
          l3Calls.push(request.toolUseId);
          return { behavior: "allow", updatedInput: request.input };
        },
      },
      queryFn: capturingQuery(captured),
    });

    expect(harness.config.permissionMode).toBe(L2_PERMISSION_MODE);
    expect(harness.config.allowedTools).toEqual(["Read(src/**)", "Bash(ls *)"]);
    expect(harness.invocation.permissionMode).toBe(L2_PERMISSION_MODE);
    expect(harness.invocation.allowedTools).toEqual(["Read(src/**)", "Bash(ls *)"]);
    expect(harness.invocation.hooks.PreToolUse).toHaveLength(1);
    expect(harness.invocation.hooks.PreToolUse[0]?.timeout).toBe(HOOK_TIMEOUT_SECONDS);
    expect(typeof harness.invocation.canUseTool).toBe("function");

    for await (const _ of harness.query({
      prompt: "hello",
      options: { permissionMode: "plan", cwd: "/tmp" },
    })) {
      void _;
    }

    expect(captured).toHaveLength(1);
    const options = captured[0]?.options as Record<string, unknown>;
    expect(options.permissionMode).toBe(L2_PERMISSION_MODE);
    expect(options.allowedTools).toEqual(["Read(src/**)", "Bash(ls *)"]);
    expect(options.hooks).toBe(harness.invocation.hooks);
    expect(options.canUseTool).toBe(harness.invocation.canUseTool);
    expect(options.cwd).toBe("/tmp");

    const hook = harness.invocation.hooks.PreToolUse[0]?.hooks[0];
    expect(hook).toBeTypeOf("function");
    const hookResult = await hook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "ls" },
      },
      "tool-1",
      { signal: new AbortController().signal },
    );
    expect(hookResult).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "ls", gated: true },
      },
    });
    expect(l1Calls).toEqual(["tool-1"]);

    const l3 = await harness.invocation.canUseTool(
      "AskUserQuestion",
      { question: "ok?" },
      { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "req-1" },
    );
    expect(l3).toEqual({ behavior: "allow", updatedInput: { question: "ok?" } });
    expect(l3Calls).toEqual(["tool-1"]);
  });

  it("maps L1 deny to a PreToolUse permissionDecision deny", async () => {
    const harness = createHarness(deps({ l1: denyL1("nope") }));
    const hook = harness.invocation.hooks.PreToolUse[0]!.hooks[0]!;
    await expect(
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "t2",
          tool_input: { command: "rm -rf /" },
        },
        "t2",
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "nope",
      },
    });
  });

  it("fails closed when L1 throws", async () => {
    const harness = createHarness(
      deps({
        l1: {
          async handle() {
            throw new Error("broker unreachable");
          },
        },
      }),
    );
    const hook = harness.invocation.hooks.PreToolUse[0]!.hooks[0]!;
    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "t3",
        tool_input: {},
      },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "broker unreachable",
      },
    });
  });

  it("fails closed when L3 throws", async () => {
    const harness = createHarness(
      deps({
        l3: {
          async canUseTool() {
            throw new Error("timeout");
          },
        },
      }),
    );
    await expect(
      harness.invocation.canUseTool("AskUserQuestion", {}, {
        signal: new AbortController().signal,
        toolUseID: "t4",
        requestId: "r4",
      }),
    ).resolves.toEqual({ behavior: "deny", message: "timeout" });
  });

  it("rejects missing ports and non-dontAsk L2", () => {
    expect(() => createHarness({} as HarnessDeps)).toThrow(HarnessFactoryError);
    expect(() =>
      createHarness(
        deps({
          l2: { permissionMode: "default" as unknown as typeof L2_PERMISSION_MODE, allowedTools: [] },
        }),
      ),
    ).toThrow(/dontAsk/);
  });

  it("does not hard-import concrete adapters", () => {
    const forbidden = [
      "hooks/pretooluse",
      "l3/canusetool",
      "l2/allowed-tools",
      "@oikonomos/agent-providers",
    ];
    for (const file of readSrc()) {
      for (const needle of forbidden) {
        expect(file.body, `${file.name} imports ${needle}`).not.toContain(needle);
      }
    }
  });

  it("contains none of the banned permission-mode tokens", () => {
    const tokens = bannedModeTokens();
    expect(tokens).toHaveLength(2);
    for (const file of readSrc()) {
      for (const token of tokens) {
        expect(file.body, `${file.name} contains ${token}`).not.toContain(token);
      }
    }
    const testDir = dirname(fileURLToPath(import.meta.url));
    const testBody = readFileSync(join(testDir, "factory.test.ts"), "utf8");
    const guardBody = readFileSync(join(testDir, "sole-constructor.test.ts"), "utf8");
    for (const token of tokens) {
      expect(testBody).not.toContain(token);
      expect(guardBody).not.toContain(token);
    }
  });
});

describe("createHarness — subprocess spawn gate (Codex/Grok)", () => {
  it("routes spawn through L1 and allows only after L1 allow", async () => {
    const seen: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const harness = createHarness(
      deps({
        l1: {
          async handle(request) {
            seen.push({ toolName: request.toolName, input: request.input });
            return { decision: "allow", updatedInput: request.input };
          },
        },
      }),
    );

    const request = {
      provider: "codex" as const,
      command: "codex",
      args: ["exec", "--json", "do work"],
      cwd: "/workspace",
    };
    await expect(harness.gateSubprocess(request)).resolves.toEqual({ allow: true, request });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolName).toBe(SUBPROCESS_TOOL_NAME);
    expect(seen[0]?.input.provider).toBe("codex");
    expect(seen[0]?.input.command).toBe("codex exec --json do work");
  });

  it("does not allow spawn when L1 denies or throws", async () => {
    const denied = createHarness(deps({ l1: denyL1("broker deny") }));
    await expect(
      denied.gateSubprocess({
        provider: "grok",
        command: "grok",
        args: ["-p", "hi"],
        cwd: "/workspace",
      }),
    ).resolves.toEqual({ allow: false, message: "broker deny" });

    const exploding = createHarness(
      deps({
        l1: {
          async handle() {
            throw new Error("timeout");
          },
        },
      }),
    );
    await expect(
      exploding.gateSubprocess({
        provider: "codex",
        command: "codex",
        args: [],
        cwd: "/workspace",
      }),
    ).resolves.toEqual({ allow: false, message: "timeout" });
  });
});

describe("createHarness — optional PostToolUse port", () => {
  it("attaches a PostToolUse matcher when the port is supplied", async () => {
    const seen: string[] = [];
    const postToolUse: PostToolUseHookPort = {
      async handle(request) {
        seen.push(request.toolUseId);
      },
    };
    const harness = createHarness(deps({ postToolUse }));
    expect(harness.invocation.hooks.PostToolUse).toHaveLength(1);
    await harness.invocation.hooks.PostToolUse![0]!.hooks[0]! (
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "done-1",
        tool_input: { command: "ls" },
        tool_response: { ok: true },
      },
      "done-1",
      { signal: new AbortController().signal },
    );
    expect(seen).toEqual(["done-1"]);
  });
});
