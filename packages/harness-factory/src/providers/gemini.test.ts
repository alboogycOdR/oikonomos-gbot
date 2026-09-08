import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGeminiAdapter,
  GEMINI_REQUEST_TIMEOUT_MS,
  STAGE_TWO_MAXIMUM_TOOL_TIER,
  type GeminiTool,
} from "./gemini.js";
import { composeHarness } from "../compose.js";

const source = readFileSync(new URL("./gemini.ts", import.meta.url), "utf8");
const originalApiKey = process.env.GEMINI_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalApiKey;
  }
  vi.useRealTimers();
});

function withNonSecretTestValue(): void {
  // This is deliberately not a credential; the transport is always fake.
  process.env.GEMINI_API_KEY = "unit-test-not-a-credential";
}

type Usage = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };

function functionCall(name = "observe", args: Record<string, unknown> = { path: "inbox" }, usageMetadata?: Usage): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }],
    ...(usageMetadata === undefined ? {} : { usageMetadata }),
  }));
}

function text(textValue = "observed", usageMetadata?: Usage): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: textValue }] } }],
    ...(usageMetadata === undefined ? {} : { usageMetadata }),
  }));
}

function tool(execute: GeminiTool["execute"], tier = 0): GeminiTool {
  return { name: "observe", description: "Observe data", tier, execute };
}

describe("Gemini adapter — governed Stage-1 function loop", () => {
  it("is loaded only for explicit provider selection; omitted provider retains the Claude runtime", () => {
    const base = {
      run: {
        runId: "gemini-compose-run",
        roleId: "observer",
        tenantId: "tenant",
        agentRef: { provider: "claude", sessionRef: "session", isSubagent: false },
      },
      allowedTools: [],
      auditSink: { async writeCompletionEvidence() {} },
      pretooluse: {
        async handlePreToolUse() {
          return { decision: "allow" as const, tier: "T0", auditEventId: "audit" };
        },
        dependencies: {},
      },
    };
    expect(composeHarness(base).gemini).toBeUndefined();
    expect(composeHarness({ ...base, provider: "gemini" }).gemini?.run).toBeTypeOf("function");
  });

  it("ignores a rogue l1 smuggled through the gemini options object (TASK-215 R1)", async () => {
    // The composition root used to build the adapter as
    // `{ l1, ...(options.gemini ?? {}) }` — spreading the CALLER's object
    // after the broker port, so an `l1` key inside it replaced enforcement
    // wholesale (CLAUDE.md non-negotiable 1). TypeScript's excess-property
    // check only guards object literals, so a typed variable or parsed JSON
    // passed straight through.
    withNonSecretTestValue();
    const realL1 = vi.fn(async () => ({ decision: "deny" as const, message: "denied by the real broker" }));
    const rogueL1 = vi.fn(async () => ({ decision: "allow" as const }));
    const execute = vi.fn(async () => ({ shouldNot: "run" }));

    const smuggled = {
      tools: [tool(execute)],
      fetch: async (_url: unknown, init: { body?: unknown } | undefined) =>
        (String(init?.body ?? "").includes("functionResponse") ? text() : functionCall()),
      // Not reachable through the declared type; this is what a widened or
      // dynamically-built options object looks like at runtime.
      l1: { handle: rogueL1 },
    } as unknown as Parameters<typeof composeHarness>[0]["gemini"];

    const composed = composeHarness({
      run: {
        runId: "gemini-r1-run",
        roleId: "observer",
        tenantId: "tenant",
        agentRef: { provider: "claude", sessionRef: "session", isSubagent: false },
      },
      allowedTools: [],
      auditSink: { async writeCompletionEvidence() {} },
      provider: "gemini",
      gemini: smuggled,
      pretooluse: {
        async handlePreToolUse() {
          await realL1();
          return { decision: "deny" as const, reason: "denied by the real broker", auditEventId: "audit" };
        },
        dependencies: {},
      },
    });

    await composed.gemini?.run("observe");
    // The smuggled port is never consulted, and the tool never runs.
    expect(rogueL1).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("awaits L1 before executing a function call or returning its functionResponse", async () => {
    withNonSecretTestValue();
    const order: string[] = [];
    let requests = 0;
    const adapter = createGeminiAdapter({
      l1: {
        async handle(request) {
          order.push(`l1:${request.toolName}`);
          return { decision: "allow", updatedInput: { ...request.input, gated: true } };
        },
      },
      tools: [tool(async (args) => {
        order.push(`execute:${String(args.gated)}`);
        return { ok: true };
      })],
      fetch: async (_url, init) => {
        requests += 1;
        if (requests === 1) {
          order.push("request");
          return functionCall();
        }
        const payload = JSON.parse(String(init?.body)) as { contents: Array<{ parts: unknown[] }> };
        expect(payload.contents.at(-1)?.parts).toEqual([
          { functionResponse: { name: "observe", response: { result: { ok: true } } } },
        ]);
        order.push("functionResponse");
        return text();
      },
    });

    await expect(adapter.run("observe the inbox")).resolves.toMatchObject({ text: "observed", denied: false });
    expect(order).toEqual(["request", "l1:observe", "execute:true", "functionResponse"]);
  });

  it("returns L1's denial to Gemini and never invokes the tool", async () => {
    withNonSecretTestValue();
    const execute = vi.fn(async () => ({ shouldNot: "run" }));
    let responsePayload = "";
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "deny", message: "approval required" }; } },
      tools: [tool(execute)],
      fetch: async (_url, init) => {
        responsePayload = String(init?.body ?? "");
        return responsePayload.includes("functionResponse") ? text() : functionCall();
      },
    });

    await expect(adapter.run("observe")).resolves.toMatchObject({ denied: false });
    expect(execute).not.toHaveBeenCalled();
    expect(responsePayload).toContain("approval required");
  });

  it("LIVENESS: removing the adapter L1 call makes the denied-tool canary RED", async () => {
    expect(source).toContain("await l1.handle(");
    const execute = vi.fn(async () => ({ shouldNot: "run" }));
    withNonSecretTestValue();
    let requests = 0;
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "deny", message: "denied by L1" }; } },
      tools: [tool(execute)],
      fetch: async () => (requests++ === 0 ? functionCall() : text()),
    });

    await adapter.run("observe");
    // If the awaited L1 call above is bypassed, this Tier-0 tool executes.
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a tool above the Stage-1 Tier-0 ceiling", async () => {
    withNonSecretTestValue();
    const execute = vi.fn(async () => ({ shouldNot: "run" }));
    let responsePayload = "";
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      tools: [tool(execute, 1)],
      fetch: async (_url, init) => {
        responsePayload = String(init?.body ?? "");
        return responsePayload.includes("functionResponse") ? text() : functionCall();
      },
    });

    await adapter.run("observe");
    expect(execute).not.toHaveBeenCalled();
    expect(responsePayload).toContain("tier 0 or below");
  });

  // TASK-212 — the Stage-1 -> Stage-2 promotion.
  it("runs a tool at the configured Stage-2 ceiling that Stage 1 refused", async () => {
    withNonSecretTestValue();
    const execute = vi.fn(async () => ({ ran: true }));
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      tools: [tool(execute, STAGE_TWO_MAXIMUM_TOOL_TIER)],
      maximumToolTier: STAGE_TWO_MAXIMUM_TOOL_TIER,
      fetch: async (_url, init) => (String(init?.body ?? "").includes("functionResponse") ? text() : functionCall()),
    });

    await adapter.run("browse");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("still refuses a tool ABOVE the configured ceiling", async () => {
    withNonSecretTestValue();
    const execute = vi.fn(async () => ({ shouldNot: "run" }));
    let responsePayload = "";
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      // T3_external: an approval-requiring tier, deliberately out of reach.
      tools: [tool(execute, STAGE_TWO_MAXIMUM_TOOL_TIER + 1)],
      maximumToolTier: STAGE_TWO_MAXIMUM_TOOL_TIER,
      fetch: async (_url, init) => {
        responsePayload = String(init?.body ?? "");
        return responsePayload.includes("functionResponse") ? text() : functionCall();
      },
    });

    await adapter.run("browse");
    expect(execute).not.toHaveBeenCalled();
    expect(responsePayload).toContain(`tier ${STAGE_TWO_MAXIMUM_TOOL_TIER} or below`);
  });

  it("refuses a ceiling above T2 at construction rather than honouring it", () => {
    withNonSecretTestValue();
    const build = (maximumToolTier: number) => createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      maximumToolTier,
      fetch: async () => text(),
    });

    // T3_external / T4_irreversible are the approval-requiring tiers. Handing
    // them to the cheapest model in the fleet is a separate ADR decision, so
    // configuration must not be able to reach them.
    expect(() => build(STAGE_TWO_MAXIMUM_TOOL_TIER + 1)).toThrow(/maximumToolTier/);
    expect(() => build(4)).toThrow(/maximumToolTier/);
    expect(() => build(-1)).toThrow(/maximumToolTier/);
    expect(() => build(1.5)).toThrow(/maximumToolTier/);
    expect(() => build(STAGE_TWO_MAXIMUM_TOOL_TIER)).not.toThrow();
  });

  it("defaults to the Stage-1 ceiling, so every existing caller is unchanged", async () => {
    withNonSecretTestValue();
    const execute = vi.fn(async () => ({ shouldNot: "run" }));
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      tools: [tool(execute, 1)],
      fetch: async (_url, init) => (String(init?.body ?? "").includes("functionResponse") ? text() : functionCall()),
    });

    await adapter.run("observe");
    expect(execute).not.toHaveBeenCalled();
  });

  it("never reaches the broker for an above-ceiling tool, so no single-use approval is burned", async () => {
    // Fable review of 81be2aa. With the broker first, a T3 call could consume
    // a nonce-bound, single-use operator approval (CLAUDE.md non-negotiable 8)
    // and THEN be refused locally — spending the operator's approval on an
    // action that never ran, with the refusal invisible to the broker.
    withNonSecretTestValue();
    const handle = vi.fn(async () => ({ decision: "allow" as const }));
    const execute = vi.fn(async () => ({ shouldNot: "run" }));
    const adapter = createGeminiAdapter({
      l1: { handle },
      tools: [tool(execute, 3)],
      maximumToolTier: STAGE_TWO_MAXIMUM_TOOL_TIER,
      fetch: async (_url, init) => (String(init?.body ?? "").includes("functionResponse") ? text() : functionCall()),
    });

    await adapter.run("browse");
    expect(execute).not.toHaveBeenCalled();
    // The point of the whole finding: the broker is never consulted at all.
    expect(handle).not.toHaveBeenCalled();
  });

  it("still consults the broker for a tool within the ceiling — the pre-filter only ever denies", async () => {
    withNonSecretTestValue();
    const handle = vi.fn(async () => ({ decision: "deny" as const, message: "approval required" }));
    const execute = vi.fn(async () => ({ shouldNot: "run" }));
    const adapter = createGeminiAdapter({
      l1: { handle },
      tools: [tool(execute, STAGE_TWO_MAXIMUM_TOOL_TIER)],
      maximumToolTier: STAGE_TWO_MAXIMUM_TOOL_TIER,
      fetch: async (_url, init) => (String(init?.body ?? "").includes("functionResponse") ? text() : functionCall()),
    });

    await adapter.run("browse");
    // Passing the local ceiling grants nothing: the broker is still the only
    // source of allow, and its denial still stops execution.
    expect(handle).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps the absolute bound independent of the Stage-2 ceiling", () => {
    // Guard for the aliasing mistake Fable flagged: if these are ever
    // collapsed back together, raising Stage 2 would silently raise the
    // backstop that exists to constrain it.
    const source = readFileSync(new URL("./gemini.ts", import.meta.url), "utf8");
    expect(source).toContain("const ABSOLUTE_MAXIMUM_TOOL_TIER = 2;");
    expect(source).not.toContain("ABSOLUTE_MAXIMUM_TOOL_TIER = STAGE_TWO_MAXIMUM_TOOL_TIER");
  });

  it("LIVENESS: an inert tier ceiling is detectable — an above-ceiling tool must never execute", async () => {
    // ADR-005 / ADR-011 §7's canary, keyed on the refusal the check emits
    // when it does its job. Deleting the tier block in decideFunctionCall
    // lets this T3 tool run on an L1 that allows everything, turning this
    // red — which is the whole point: the broker is the authority, and this
    // ceiling is the backstop for when the broker is misconfigured.
    withNonSecretTestValue();
    const execute = vi.fn(async () => ({ shouldNot: "run" }));
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      tools: [tool(execute, 3)],
      maximumToolTier: STAGE_TWO_MAXIMUM_TOOL_TIER,
      fetch: async (_url, init) => (String(init?.body ?? "").includes("functionResponse") ? text() : functionCall()),
    });

    await adapter.run("browse");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed response", async () => new Response("not-json")],
    ["HTTP failure", async () => new Response("unavailable", { status: 503 })],
  ])("fails closed on a %s", async (_label, fetch) => {
    withNonSecretTestValue();
    const adapter = createGeminiAdapter({ l1: { async handle() { return { decision: "allow" }; } }, fetch });
    await expect(adapter.run("observe")).resolves.toMatchObject({ denied: true, text: "" });
  });

  // TASK-220 — GeminiRunResult previously discarded the real API's
  // `usageMetadata`, so every recorded Gemini spend was a hardcoded zero
  // regardless of what a run actually cost.
  it("captures real usageMetadata from a single-turn response (TASK-220)", async () => {
    withNonSecretTestValue();
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      fetch: async () => text("observed", { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 130, totalTokenCount: 143 }),
    });

    const result = await adapter.run("observe");
    expect(result.usage).toEqual({ promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 130, totalTokenCount: 143 });
  });

  it("sums usage across every real API call in a multi-turn tool-calling run, not just the last one (TASK-220)", async () => {
    withNonSecretTestValue();
    const execute = vi.fn(async () => ({ ok: true }));
    let requests = 0;
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      tools: [tool(execute, 0)],
      fetch: async () => {
        requests += 1;
        // Turn 1: a function call, its own real usage. Turn 2: the final
        // answer, its own separate real usage. A real conversation is
        // billed per call, not once for the whole exchange.
        return requests === 1
          ? functionCall("observe", { path: "inbox" }, { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0, totalTokenCount: 15 })
          : text("done", { promptTokenCount: 20, candidatesTokenCount: 8, thoughtsTokenCount: 2, totalTokenCount: 30 });
      },
    });

    const result = await adapter.run("observe");
    expect(requests).toBe(2);
    expect(result.usage).toEqual({ promptTokenCount: 30, candidatesTokenCount: 13, thoughtsTokenCount: 2, totalTokenCount: 45 });
  });

  it("reports zero usage, not a crash, for a malformed or missing usageMetadata block", async () => {
    withNonSecretTestValue();
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      // No usageMetadata at all — matches the OpenAI-compatible surface,
      // which is the exact shape that under-billed by ~30x before TASK-215's
      // own thinking-token fix; this adapter must not crash on its absence.
      fetch: async () => text("observed"),
    });

    const result = await adapter.run("observe");
    expect(result.usage).toEqual({ promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0 });
  });

  it("LIVENESS: usage capture is detectable — a stripped usageMetadata block collapses real usage to zero", async () => {
    withNonSecretTestValue();
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      fetch: async () => text("observed", { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 130, totalTokenCount: 143 }),
    });
    const result = await adapter.run("observe");
    expect(result.usage.totalTokenCount).toBe(143);

    // Mutation: source-level guard confirming `usageFrom` genuinely reads
    // `usageMetadata` rather than being dead code the compiler happens to
    // accept — mirrors this file's other LIVENESS assertions.
    expect(source).toContain("usageFrom(parsed)");
  });

  it("fails closed on a request timeout without an unhandled rejection", async () => {
    withNonSecretTestValue();
    vi.useFakeTimers();
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      timeoutMs: 5,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    const pending = adapter.run("observe");
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toMatchObject({ denied: true, text: "" });
  });

  it("reads the key only from construction-time env and never sends it to a payload, log, audit, or fixture", async () => {
    expect(source).toContain("process.env.GEMINI_API_KEY");
    expect(source).not.toMatch(/console\.|\baudit\b/i);
    expect(source).not.toContain("GEMINI_API_KEY =");
    expect(GEMINI_REQUEST_TIMEOUT_MS).toBe(10_000);

    withNonSecretTestValue();
    const log = vi.spyOn(console, "log");
    let body = "";
    const adapter = createGeminiAdapter({
      l1: { async handle() { return { decision: "allow" }; } },
      fetch: async (_url, init) => {
        body = String(init?.body ?? "");
        return text();
      },
    });
    await adapter.run("summarize");
    expect(body).not.toContain(process.env.GEMINI_API_KEY!);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
