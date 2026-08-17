import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GrokProvider, buildGrokArgs } from "../src/providers/grok.js";
import type { GateSpawn } from "../src/providers/codex.js";
import type { ProviderEvent } from "../src/types.js";

describe("buildGrokArgs", () => {
  const baseConfig = { defaultModel: "grok-4.5", sandbox: "workspace" as const, alwaysApprove: true };

  it("builds args for a brand-new session using -s with the provided uuid", () => {
    const args = buildGrokArgs(
      { prompt: "hello", cwd: "/tmp/proj", model: null, sessionId: null },
      baseConfig,
      "new-uuid-123",
    );
    expect(args).toEqual([
      "-p",
      "hello",
      "--cwd",
      "/tmp/proj",
      "--output-format",
      "plain",
      "--no-alt-screen",
      "--no-auto-update",
      "--sandbox",
      "workspace",
      "-m",
      "grok-4.5",
      "--always-approve",
      "-s",
      "new-uuid-123",
    ]);
  });

  it("resumes an existing session with -r instead of -s", () => {
    const args = buildGrokArgs(
      { prompt: "continue", cwd: "/tmp/proj", model: null, sessionId: "existing-id" },
      baseConfig,
      "unused-uuid",
    );
    expect(args).toContain("-r");
    expect(args).toContain("existing-id");
    expect(args).not.toContain("-s");
  });

  it("uses the caller-specified model over the configured default", () => {
    const args = buildGrokArgs(
      { prompt: "x", cwd: "/tmp", model: "grok-build-0.1", sessionId: null },
      baseConfig,
      "u1",
    );
    const modelIdx = args.indexOf("-m");
    expect(args[modelIdx + 1]).toBe("grok-build-0.1");
  });

  it("omits --always-approve when configured off", () => {
    const args = buildGrokArgs(
      { prompt: "x", cwd: "/tmp", model: null, sessionId: null },
      { ...baseConfig, alwaysApprove: false },
      "u1",
    );
    expect(args).not.toContain("--always-approve");
  });

  it("passes through the configured sandbox profile", () => {
    const args = buildGrokArgs(
      { prompt: "x", cwd: "/tmp", model: null, sessionId: null },
      { ...baseConfig, sandbox: "read-only" },
      "u1",
    );
    const sandboxIdx = args.indexOf("--sandbox");
    expect(args[sandboxIdx + 1]).toBe("read-only");
  });
});

/**
 * These tests point GrokProvider at a real short-lived subprocess — a tiny
 * wrapper that execs a Node script standing in for the `grok` binary —
 * so the streaming/exit-code/abort paths in sendPrompt() are exercised
 * against real process I/O rather than mocked away. No network or real xAI
 * credentials involved; the wrapper ignores every arg GrokProvider passes.
 *
 * On Windows the original `#!/bin/sh` shim cannot be spawned, so the helper
 * writes a `.cmd` wrapper instead. The 10 assertions are unchanged.
 */
describe("GrokProvider (subprocess integration via a fake grok binary)", () => {
  const tmpDirs: string[] = [];

  /** Writes a Node script and a platform wrapper that execs it, ignoring all args. */
  function makeFakeGrokBin(script: string): string {
    const scriptDir = mkdtempSync(path.join(tmpdir(), "grok-fake-script-"));
    const wrapperDir = mkdtempSync(path.join(tmpdir(), "grok-fake-bin-"));
    tmpDirs.push(scriptDir, wrapperDir);

    const scriptPath = path.join(scriptDir, "fake-grok.cjs");
    writeFileSync(scriptPath, script, "utf-8");

    if (process.platform === "win32") {
      const wrapperPath = path.join(wrapperDir, "grok.cmd");
      writeFileSync(
        wrapperPath,
        `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`,
        "utf-8",
      );
      return wrapperPath;
    }

    const wrapperPath = path.join(wrapperDir, "grok");
    writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}"\n`, "utf-8");
    chmodSync(wrapperPath, 0o755);
    return wrapperPath;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeProvider(bin: string, overrides: Partial<{ sandbox: "workspace" | "read-only"; alwaysApprove: boolean; gateSpawn: GateSpawn }> = {}) {
    return new GrokProvider({
      bin,
      defaultModel: "grok-4.5",
      sandbox: overrides.sandbox ?? "workspace",
      alwaysApprove: overrides.alwaysApprove ?? true,
      gateSpawn: overrides.gateSpawn ?? (async () => ({ allow: true })),
    });
  }

  async function collect(provider: GrokProvider, signal: AbortSignal = new AbortController().signal): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    for await (const event of provider.sendPrompt({
      prompt: "say hi",
      cwd: process.cwd(),
      sessionId: null,
      model: null,
      signal,
    })) {
      events.push(event);
    }
    return events;
  }

  it("streams stdout chunks as text_delta and ends with turn_complete on exit 0", async () => {
    const bin = makeFakeGrokBin(`
      process.stdout.write("Hello ");
      process.stdout.write("world");
      process.exit(0);
    `);
    const events = await collect(makeProvider(bin));

    const textEvents = events.filter((e): e is { type: "text_delta"; text: string } => e.type === "text_delta");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello world");

    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "turn_complete", costUsd: null, turns: 1 });
    expect((last as { sessionId: string }).sessionId).toBeTruthy();
  });

  it("emits a fatal error with the stderr tail when the process exits non-zero", async () => {
    const bin = makeFakeGrokBin(`
      process.stderr.write("something went wrong");
      process.exit(1);
    `);
    const events = await collect(makeProvider(bin));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", fatal: true });
    expect((events[0] as { message: string }).message).toContain("something went wrong");
  });

  it("emits a fatal error when the process exits 0 with no output at all", async () => {
    const bin = makeFakeGrokBin(`process.exit(0);`);
    const events = await collect(makeProvider(bin));
    expect(events).toEqual([{ type: "error", fatal: true, message: "Grok Build returned an empty response." }]);
  });

  it("emits a non-fatal interrupted error when aborted mid-stream", async () => {
    const bin = makeFakeGrokBin(`
      process.stdout.write("partial");
      setTimeout(() => process.exit(0), 5000);
    `);
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    // Gate abort on the first observed text_delta so the interrupt cannot
    // win a spawn/I/O race under CPU contention (a fixed timeout did).
    for await (const event of makeProvider(bin).sendPrompt({
      prompt: "say hi",
      cwd: process.cwd(),
      sessionId: null,
      model: null,
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "text_delta" && !controller.signal.aborted) {
        controller.abort();
      }
    }

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "error", message: "Interrupted by user.", fatal: false });
  }, 10_000);

  it("declares itself agentic with resumable sessions but no permission prompts", () => {
    const provider = makeProvider("grok");
    expect(provider.capabilities).toEqual({
      agentic: true,
      resumableSessions: true,
      permissionPrompts: false,
      interruptible: true,
    });
  });

  it("fails closed without a gate and never spawns the CLI", async () => {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "grok-gate-marker-")), "spawned.txt");
    tmpDirs.push(path.dirname(marker));
    const previous = process.env.SPAWN_SENTINEL;
    process.env.SPAWN_SENTINEL = marker;
    const bin = makeFakeGrokBin("require('node:fs').writeFileSync(process.env.SPAWN_SENTINEL, 'spawned');");
    const provider = new GrokProvider({ bin, defaultModel: "grok-4.5", sandbox: "workspace", alwaysApprove: true });
    const events = await collect(provider);
    expect(events).toEqual([{ type: "error", fatal: true, message: "Grok spawn denied: broker gate is not configured." }]);
    expect(existsSync(marker)).toBe(false);
    if (previous === undefined) delete process.env.SPAWN_SENTINEL;
    else process.env.SPAWN_SENTINEL = previous;
  });

  it("does not spawn the CLI when the broker denies or throws", async () => {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "grok-gate-marker-")), "spawned.txt");
    tmpDirs.push(path.dirname(marker));
    const previous = process.env.SPAWN_SENTINEL;
    process.env.SPAWN_SENTINEL = marker;
    const bin = makeFakeGrokBin("require('node:fs').writeFileSync(process.env.SPAWN_SENTINEL, 'spawned');");
    const denied = await collect(makeProvider(bin, { gateSpawn: async () => ({ allow: false, message: "approval required" }) }));
    expect(denied[0]).toMatchObject({ type: "error", fatal: true, message: "Grok spawn denied: approval required" });
    expect(existsSync(marker)).toBe(false);
    const threw = await collect(makeProvider(bin, { gateSpawn: async () => { throw new Error("broker unavailable"); } }));
    expect(threw[0]).toMatchObject({ type: "error", fatal: true, message: "Grok spawn denied: broker gate failed closed: broker unavailable" });
    expect(existsSync(marker)).toBe(false);
    if (previous === undefined) delete process.env.SPAWN_SENTINEL;
    else process.env.SPAWN_SENTINEL = previous;
  });
});
