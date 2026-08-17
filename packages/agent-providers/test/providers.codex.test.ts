import { describe, it, expect } from "vitest";
import { mapCodexEvent, isCodexEvent } from "../src/providers/codex.js";

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
