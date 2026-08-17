import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexProvider, mapCodexEvent, isCodexEvent } from "../src/providers/codex.js";
import type { ProviderEvent } from "../src/types.js";

describe("isCodexEvent", () => {
  it("accepts objects with a string type field", () => {
    expect(isCodexEvent({ type: "thread.started", thread_id: "x" })).toBe(true);
  });

  it("rejects null, arrays, and typeless objects", () => {
    expect(isCodexEvent(null)).toBe(false);
    expect(isCodexEvent([])).toBe(false);
    expect(isCodexEvent({})).toBe(false);
    expect(isCodexEvent({ type: 5 })).toBe(false);
  });
});

describe("mapCodexEvent", () => {
  it("maps a completed assistant_message item to a text_delta", () => {
    const events = mapCodexEvent(
      {
        type: "item.completed",
        item: { id: "item_0", item_type: "assistant_message", text: "Hello!" },
      },
      new Map(),
    );
    expect(events).toEqual([{ type: "text_delta", text: "Hello!" }]);
  });

  it("skips an assistant_message item with empty text", () => {
    const events = mapCodexEvent(
      { type: "item.completed", item: { id: "item_0", item_type: "assistant_message", text: "" } },
      new Map(),
    );
    expect(events).toEqual([]);
  });

  it("maps a completed reasoning item to a thinking_delta", () => {
    const events = mapCodexEvent(
      { type: "item.completed", item: { id: "item_1", item_type: "reasoning", text: "**Thinking**" } },
      new Map(),
    );
    expect(events).toEqual([{ type: "thinking_delta", text: "**Thinking**" }]);
  });

  it("maps a started command_execution to tool_start and tracks it as open", () => {
    const open = new Map<string, string>();
    const events = mapCodexEvent(
      {
        type: "item.started",
        item: { id: "item_2", item_type: "command_execution", command: "ls -la", status: "in_progress" },
      },
      open,
    );
    expect(events).toEqual([{ type: "tool_start", toolName: "bash", toolUseId: "item_2", summary: "ls -la" }]);
    expect(open.get("item_2")).toBe("command_execution");
  });

  it("maps a completed command_execution to tool_end with ok=true on exit_code 0", () => {
    const open = new Map<string, string>([["item_2", "command_execution"]]);
    const events = mapCodexEvent(
      {
        type: "item.completed",
        item: { id: "item_2", item_type: "command_execution", aggregated_output: "file1\nfile2\n", exit_code: 0 },
      },
      open,
    );
    expect(events).toEqual([{ type: "tool_end", toolUseId: "item_2", ok: true, summary: "file1\nfile2" }]);
    expect(open.has("item_2")).toBe(false);
  });

  it("maps a completed command_execution to tool_end with ok=false on nonzero exit_code", () => {
    const events = mapCodexEvent(
      {
        type: "item.completed",
        item: { id: "item_3", item_type: "command_execution", aggregated_output: "boom", exit_code: 1 },
      },
      new Map(),
    );
    expect(events[0]).toMatchObject({ type: "tool_end", ok: false });
  });

  it("truncates long command summaries to 120 chars", () => {
    const longCommand = "echo " + "x".repeat(200);
    const events = mapCodexEvent(
      { type: "item.started", item: { id: "item_4", item_type: "command_execution", command: longCommand } },
      new Map(),
    );
    const summary = (events[0] as { summary: string }).summary;
    expect(summary.length).toBe(120);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("maps file_change start/complete to tool_start/tool_end", () => {
    const open = new Map<string, string>();
    const started = mapCodexEvent({ type: "item.started", item: { id: "f1", item_type: "file_change" } }, open);
    expect(started[0]).toMatchObject({ type: "tool_start", toolName: "file_change" });
    expect(open.get("f1")).toBe("file_change");

    const completed = mapCodexEvent({ type: "item.completed", item: { id: "f1", item_type: "file_change" } }, open);
    expect(completed[0]).toMatchObject({ type: "tool_end", ok: true });
    expect(open.has("f1")).toBe(false);
  });

  it("maps mcp_tool_call start/complete to tool_start/tool_end", () => {
    const open = new Map<string, string>();
    const started = mapCodexEvent({ type: "item.started", item: { id: "m1", item_type: "mcp_tool_call" } }, open);
    expect(started[0]).toMatchObject({ type: "tool_start", toolName: "mcp_tool_call" });

    const completed = mapCodexEvent({ type: "item.completed", item: { id: "m1", item_type: "mcp_tool_call" } }, open);
    expect(completed[0]).toMatchObject({ type: "tool_end", ok: true });
  });

  it("maps a completed web_search item to a paired tool_start + tool_end", () => {
    const events = mapCodexEvent({ type: "item.completed", item: { id: "w1", item_type: "web_search" } }, new Map());
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "tool_start", toolName: "web_search" });
    expect(events[1]).toMatchObject({ type: "tool_end", ok: true });
  });

  it("ignores unrecognized item types without throwing", () => {
    const events = mapCodexEvent(
      { type: "item.completed", item: { id: "u1", item_type: "some_future_item_type" } },
      new Map(),
    );
    expect(events).toEqual([]);
  });

  it("ignores thread.started / turn.started / turn.completed / turn.failed (handled by the caller, not the mapper)", () => {
    expect(mapCodexEvent({ type: "thread.started", thread_id: "t1" }, new Map())).toEqual([]);
    expect(mapCodexEvent({ type: "turn.started" }, new Map())).toEqual([]);
    expect(mapCodexEvent({ type: "turn.completed" }, new Map())).toEqual([]);
    expect(mapCodexEvent({ type: "turn.failed", error: { message: "boom" } }, new Map())).toEqual([]);
  });
});

describe("CodexProvider subprocess gate", () => {
  const tmpDirs: string[] = [];

  function makeSentinelBin(): string {
    const scriptDir = mkdtempSync(path.join(tmpdir(), "codex-gate-script-"));
    const wrapperDir = mkdtempSync(path.join(tmpdir(), "codex-gate-bin-"));
    tmpDirs.push(scriptDir, wrapperDir);
    const scriptPath = path.join(scriptDir, "sentinel.cjs");
    writeFileSync(scriptPath, "require('node:fs').writeFileSync(process.env.SPAWN_SENTINEL, 'spawned');", "utf8");
    if (process.platform === "win32") {
      const wrapperPath = path.join(wrapperDir, "codex.cmd");
      writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`, "utf8");
      return wrapperPath;
    }
    const wrapperPath = path.join(wrapperDir, "codex");
    writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}"\n`, "utf8");
    chmodSync(wrapperPath, 0o755);
    return wrapperPath;
  }

  afterEach(() => {
    delete process.env.SPAWN_SENTINEL;
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function collect(provider: CodexProvider): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    for await (const event of provider.sendPrompt({
      prompt: "hello",
      cwd: process.cwd(),
      model: null,
      sessionId: null,
      signal: new AbortController().signal,
    })) events.push(event);
    return events;
  }

  function makeProvider(bin: string, gateSpawn?: ConstructorParameters<typeof CodexProvider>[0]["gateSpawn"]): CodexProvider {
    return new CodexProvider({ bin, defaultModel: "gpt-5.4", sandbox: "workspace-write", gateSpawn });
  }

  it("fails closed without a gate, proving a provider spawn is impossible without broker allow", async () => {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "codex-gate-marker-")), "spawned.txt");
    tmpDirs.push(path.dirname(marker));
    process.env.SPAWN_SENTINEL = marker;
    const events = await collect(makeProvider(makeSentinelBin()));
    expect(events).toEqual([{ type: "error", fatal: true, message: "Codex spawn denied: broker gate is not configured." }]);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not spawn when the broker denies or throws", async () => {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "codex-gate-marker-")), "spawned.txt");
    tmpDirs.push(path.dirname(marker));
    process.env.SPAWN_SENTINEL = marker;
    const denied = await collect(makeProvider(makeSentinelBin(), async () => ({ allow: false, message: "approval required" })));
    expect(denied[0]).toMatchObject({ type: "error", fatal: true, message: "Codex spawn denied: approval required" });
    expect(existsSync(marker)).toBe(false);
    const threw = await collect(makeProvider(makeSentinelBin(), async () => { throw new Error("broker unavailable"); }));
    expect(threw[0]).toMatchObject({ type: "error", fatal: true, message: "Codex spawn denied: broker gate failed closed: broker unavailable" });
    expect(existsSync(marker)).toBe(false);
  });
});
