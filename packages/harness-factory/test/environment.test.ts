import { describe, expect, it, vi } from "vitest";

import {
  bindEnvironment,
  type ConnectorSessionPool,
  type EnvironmentOptions,
} from "../src/environment.js";
import { composeHarness, type ComposeOptions } from "../src/compose.js";

const RUN = {
  runId: "11111111-1111-4111-8111-111111111111",
  roleId: "inbox-triage",
  tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "sess-environment", isSubagent: false },
};

function options(overrides: Partial<ComposeOptions> = {}): ComposeOptions {
  return {
    run: RUN,
    allowedTools: ["Read(src/**)"],
    auditSink: { async writeCompletionEvidence() {} },
    pretooluse: {
      async handlePreToolUse() {
        return { decision: "allow", tier: "T0_observe", auditEventId: "audit-environment" };
      },
      dependencies: {},
    },
    queryFn: async function* () {},
    ...overrides,
  };
}

const ENVIRONMENT: EnvironmentOptions = {
  workspaceRoot: "/oikonomos/workspace",
  roleId: RUN.roleId,
  roleDir: "/oikonomos/roles/inbox-triage",
};

describe("composeHarness — optional durable environment binding (OIK-207)", () => {
  it("omits the binding without changing the per-run composed runtime", () => {
    const first = composeHarness(options());
    const second = composeHarness(options());

    expect(first.environment).toBeUndefined();
    expect(second.environment).toBeUndefined();
    expect(first.harness).not.toBe(second.harness);
  });

  it("exposes workspace and role identity through the runtime audit identity", () => {
    const runtime = composeHarness(options({ environment: ENVIRONMENT }));

    expect(runtime.environment).toMatchObject({
      workspaceRoot: "/oikonomos/workspace",
      roleId: "inbox-triage",
      roleDir: "/oikonomos/roles/inbox-triage",
      auditIdentity: {
        runId: RUN.runId,
        roleId: RUN.roleId,
        tenantId: RUN.tenantId,
        workspaceRoot: "/oikonomos/workspace",
      },
    });
    expect(Object.isFrozen(runtime.environment)).toBe(true);
    expect(Object.isFrozen(runtime.environment?.auditIdentity)).toBe(true);
  });

  it("preserves the OIK-208 acquire/release lifecycle without a destroy path", async () => {
    const handle = { sessionId: "opaque-session" };
    const sessionPool: ConnectorSessionPool = {
      acquire: vi.fn(async () => handle),
      release: vi.fn(),
    };
    const runtime = composeHarness(options({ environment: { ...ENVIRONMENT, sessionPool } }));

    const acquired = await runtime.environment!.sessionPool!.acquire(RUN.tenantId, "gmail");
    runtime.environment!.sessionPool!.release(acquired);

    expect(sessionPool.acquire).toHaveBeenCalledWith("basileia", "gmail");
    expect(sessionPool.release).toHaveBeenCalledWith(handle);
    expect("destroy" in runtime.environment!.sessionPool!).toBe(false);
  });

  it("rejects an environment that would misattribute the run", () => {
    expect(() => bindEnvironment(RUN, { ...ENVIRONMENT, roleId: "other-role" })).toThrow(
      "environment.roleId must match run.roleId",
    );
  });
});
