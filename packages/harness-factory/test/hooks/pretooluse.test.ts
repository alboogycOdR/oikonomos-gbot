import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHarness,
  L2_PERMISSION_MODE,
  type CanUseToolPort,
  type PreToolUsePortRequest,
} from "../../src/index.js";
import {
  BROKER_PRETOOLUSE_PATH,
  BROKER_TIMEOUT_MS,
  createL1PreToolUseHook,
  type L1PreToolUseHookOptions,
} from "../../src/hooks/pretooluse.js";

const adapterSource = readFileSync(
  fileURLToPath(new URL("../../src/hooks/pretooluse.ts", import.meta.url)),
  "utf8",
);

const run = {
  runId: "run-1",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-1", isSubagent: false },
};

const request: PreToolUsePortRequest = {
  toolName: "Bash",
  toolUseId: "tool-1",
  input: { command: "ls" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hook(
  fetchImpl: typeof fetch,
  overrides: Partial<L1PreToolUseHookOptions> = {},
) {
  return createL1PreToolUseHook({
    broker: { fetch: fetchImpl, baseUrl: "http://broker.example" },
    run,
    ...overrides,
  });
}

describe("createL1PreToolUseHook — POST /v1/broker/pretooluse", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("POSTs every tool invocation to the broker and maps allow", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        decision: "allow",
        tier: "T0_observe",
        auditEventId: "evt-1",
      });
    };

    const l1 = hook(fetchImpl);
    await expect(l1.handle(request)).resolves.toEqual({ decision: "allow" });
    await expect(
      l1.handle({ ...request, toolUseId: "tool-2", toolName: "Read" }),
    ).resolves.toEqual({ decision: "allow" });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe(`http://broker.example${BROKER_PRETOOLUSE_PATH}`);
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      {
        toolUseId: "tool-1",
        runId: "run-1",
        roleId: "inbox-triage",
        tenantId: "basileia",
        toolName: "Bash",
        input: { command: "ls" },
        agentRef: { provider: "claude", sessionRef: "sess-1", isSubagent: false },
      },
      {
        toolUseId: "tool-2",
        runId: "run-1",
        roleId: "inbox-triage",
        tenantId: "basileia",
        toolName: "Read",
        input: { command: "ls" },
        agentRef: { provider: "claude", sessionRef: "sess-1", isSubagent: false },
      },
    ]);
  });

  it("maps both deny forms to a hook deny with the broker reason", async () => {
    const l1Plain = hook(async () =>
      jsonResponse({ decision: "deny", reason: "capability.disabled", auditEventId: "evt-2" }),
    );
    await expect(l1Plain.handle(request)).resolves.toEqual({
      decision: "deny",
      message: "capability.disabled",
    });

    const l1Pending = hook(async () =>
      jsonResponse({
        decision: "deny",
        reason: "approval_pending",
        approvalId: "appr-9",
        auditEventId: "evt-3",
      }),
    );
    await expect(l1Pending.handle(request)).resolves.toEqual({
      decision: "deny",
      message: "approval_pending",
    });
  });

  it("applies updatedInput on allow and leaves input unchanged when absent", async () => {
    const withUpdate = hook(async () =>
      jsonResponse({
        decision: "allow",
        tier: "T1_draft",
        auditEventId: "evt-4",
        updatedInput: { command: "ls -la" },
      }),
    );
    await expect(withUpdate.handle(request)).resolves.toEqual({
      decision: "allow",
      updatedInput: { command: "ls -la" },
    });

    const withoutUpdate = hook(async () =>
      jsonResponse({ decision: "allow", tier: "T1_draft", auditEventId: "evt-5" }),
    );
    const allowed = await withoutUpdate.handle(request);
    expect(allowed).toEqual({ decision: "allow" });
    expect(allowed).not.toHaveProperty("updatedInput");
  });

  it("fails closed on transport error", async () => {
    const l1 = hook(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(l1.handle(request)).resolves.toEqual({
      decision: "deny",
      message: "broker.unreachable",
    });
  });

  it("fails closed when the broker exceeds 10s", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });

    const pending = hook(fetchImpl).handle(request);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(BROKER_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      decision: "deny",
      message: "broker.timeout",
    });
    expect(settled).toBe(true);
  });

  it("fails closed on malformed or unparseable body", async () => {
    const unparseable = hook(async () => new Response("not-json", { status: 200 }));
    await expect(unparseable.handle(request)).resolves.toEqual({
      decision: "deny",
      message: "broker.malformed_response",
    });

    const unknownDecision = hook(async () => jsonResponse({ decision: "maybe" }));
    await expect(unknownDecision.handle(request)).resolves.toEqual({
      decision: "deny",
      message: "broker.malformed_response",
    });

    const badUpdatedInput = hook(async () =>
      jsonResponse({ decision: "allow", updatedInput: ["not", "an", "object"] }),
    );
    await expect(badUpdatedInput.handle(request)).resolves.toEqual({
      decision: "deny",
      message: "broker.malformed_response",
    });
  });

  it("fails closed on HTTP 500 without treating the body as an allow", async () => {
    const l1 = hook(async () =>
      jsonResponse({ decision: "allow", tier: "T0_observe", auditEventId: "nope" }, 500),
    );
    await expect(l1.handle(request)).resolves.toEqual({
      decision: "deny",
      message: "broker.http_500",
    });
  });

  it("forwards approvalNonce only when the injected seam provides one", async () => {
    const seen: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return jsonResponse({ decision: "allow", tier: "T3_external", auditEventId: "evt-6" });
    };

    const withNonce = hook(fetchImpl, {
      approvalNonceFor: () => "nonce-approved-retry",
    });
    await withNonce.handle(request);
    expect(seen[0]).toMatchObject({ approvalNonce: "nonce-approved-retry" });

    const withoutNonce = hook(fetchImpl);
    await withoutNonce.handle(request);
    expect(seen[1]).not.toHaveProperty("approvalNonce");
  });

  it("does not reimplement canonical JSON, digest, or a local §4.1 type", () => {
    expect(adapterSource).not.toMatch(/canonicalJson|actionDigest|createHash|sha256/i);
    expect(adapterSource).not.toMatch(/export (?:interface|type) PreToolUse(?:Request|Response)/);
    expect(adapterSource).toContain("BrokerHttpPort");
    expect(adapterSource).toContain(BROKER_PRETOOLUSE_PATH);
  });
});

describe("createL1PreToolUseHook — factory L1 port", () => {
  it("plugs into createHarness and carries updatedInput through the hook", async () => {
    const l1 = hook(async () =>
      jsonResponse({
        decision: "allow",
        tier: "T0_observe",
        auditEventId: "evt-7",
        updatedInput: { command: "ls", gated: true },
      }),
    );
    const l3: CanUseToolPort = {
      async canUseTool(req) {
        return { behavior: "allow", updatedInput: req.input };
      },
    };

    const harness = createHarness({
      l1,
      l2: { permissionMode: L2_PERMISSION_MODE, allowedTools: ["Bash(ls *)"] },
      l3,
      queryFn: async function* () {},
    });

    const sdkHook = harness.invocation.hooks.PreToolUse[0]!.hooks[0]!;
    await expect(
      sdkHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "tool-1",
          tool_input: { command: "ls" },
        },
        "tool-1",
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "ls", gated: true },
      },
    });
  });
});
