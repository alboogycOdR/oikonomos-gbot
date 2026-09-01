import { mountMcpBridge, withMcpBridge, type McpBridge } from "./mcpBridge/index.js";

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;

  const bridges: McpBridge[] = [];

  afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  });

  function rpc(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  }

  async function post(url: string, body: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  function bridge(options: Parameters<typeof mountMcpBridge>[0]): Promise<McpBridge> {
  return mountMcpBridge(options).then((mounted) => {
    bridges.push(mounted);
    return mounted;
  });
  }

  describe("ephemeral MCP bridge", () => {
  it("binds an ephemeral loopback capability path, rejects other routes, methods, and oversized bodies", async () => {
    const mounted = await bridge({ tools: [], broker: { decide: vi.fn() } });
    expect(mounted.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]{36}$/);
    expect((await fetch(`${mounted.url}/wrong`, { method: "POST" })).status).toBe(404);
    expect((await fetch(mounted.url, { method: "GET" })).status).toBe(404);
    expect((await fetch(mounted.url, { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
  });

  it("always asks the injected broker before executing a mounted tool", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({ echoed: input }));
    const decide = vi.fn(async () => ({ decision: "allow" as const }));
    const mounted = await bridge({ tools: [{ name: "connector.update", execute }], broker: { decide } });

    const response = await post(mounted.url, rpc(1, "tools/call", { name: "connector.update", arguments: { value: 1 } }));

    expect(response.status).toBe(200);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ toolName: "connector.update", input: { value: 1 } }));
    expect(execute).toHaveBeenCalledWith({ value: 1 });
  });

  it("returns broker denial guidance as an MCP error result without executing the connector", async () => {
    const execute = vi.fn();
    const mounted = await bridge({
      tools: [{ name: "connector.delete", execute }],
      broker: { decide: async () => ({ decision: "deny", modelGuidance: "Do not retry; ask the operator instead." }) },
    });

    const response = await post(mounted.url, rpc(2, "tools/call", { name: "connector.delete", arguments: {} }));
    const result = response.body.result as { isError: boolean; content: { text: string }[] };

    expect(response.status).toBe(200);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Do not retry");
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses a mount-time snapshot and refuses tools added after mounting", async () => {
    const tools = [{ name: "connector.list", execute: vi.fn(async () => "listed") }];
    const mounted = await bridge({ tools, broker: { decide: vi.fn(async () => ({ decision: "allow" as const })) } });
    tools.push({ name: "connector.injected", execute: vi.fn(async () => "bad") });

    const list = await post(mounted.url, rpc(3, "tools/list"));
    const call = await post(mounted.url, rpc(4, "tools/call", { name: "connector.injected", arguments: {} }));

    expect((list.body.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(["connector.list"]);
    expect((call.body.result as { isError: boolean }).isError).toBe(true);
  });

  it("returns manifest annotations verbatim without name-based inference", async () => {
    const annotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, title: "Manifest says read-only" });
    const mounted = await bridge({
      tools: [{ name: "delete_everything", description: "danger", annotations, execute: async () => null }],
      broker: { decide: vi.fn() },
    });

    const response = await post(mounted.url, rpc(5, "tools/list"));
    const listed = (response.body.result as { tools: { annotations: unknown }[] }).tools[0];

    expect(listed?.annotations).toEqual(annotations);
  });

  it("closes the bridge when the run throws", async () => {
    let url = "";
    await expect(withMcpBridge({ tools: [], broker: { decide: vi.fn() } }, async (mounted) => {
      url = mounted.url;
      throw new Error("run failed");
    })).rejects.toThrow("run failed");

    await expect(fetch(url)).rejects.toThrow();
  });
  });
}
