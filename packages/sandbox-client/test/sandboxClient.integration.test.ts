import { describe, expect, it } from "vitest";

import { createSandboxClient } from "../src/client.js";

/**
 * Optional real-server integration test — gated behind env vars, mirroring
 * the `DATABASE_URL`-gated `describe.skip` pattern used throughout this repo
 * (e.g. packages/approvals/src/decide.test.ts). Skips cleanly wherever
 * Tailscale connectivity or the real API key isn't available (most CI /
 * builder sandboxes). See dossiers/TASK-142.md for whether this was actually
 * exercised against the live clawsrv server in a given session, and its result.
 *
 * To run for real:
 *   SANDBOX_INTEGRATION_URL=http://100.78.70.2:8080 \
 *   OIK_SECRET_OPENSANDBOX_API_KEY=<the real key, never committed anywhere> \
 *   pnpm --filter @oikonomos/sandbox-client test -- sandboxClient.integration
 */
const baseUrl = process.env.SANDBOX_INTEGRATION_URL;
const hasApiKey = process.env.OIK_SECRET_OPENSANDBOX_API_KEY !== undefined;
const hasExecdToken = process.env.OIK_SECRET_OPENSANDBOX_EXECD_ACCESS_TOKEN !== undefined;
const integration = baseUrl !== undefined && hasApiKey && hasExecdToken ? describe : describe.skip;

integration("createSandboxClient — live clawsrv OpenSandbox server", () => {
  it("health check succeeds against the real server", async () => {
    const client = createSandboxClient({ baseUrl: baseUrl as string });
    const result = await client.health();
    expect(result.status).toBe("healthy");
  });

  it("creates and then destroys a real sandbox", async () => {
    const client = createSandboxClient({ baseUrl: baseUrl as string });

    const created = await client.createSandbox({
      image: { uri: "alpine:3.20" },
      entrypoint: ["tail", "-f", "/dev/null"],
      resourceLimits: { cpu: "250m", memory: "128Mi" },
      timeout: 120,
      metadata: { purpose: "TASK-142-connectivity-proof" },
    });

    expect(created.id).toEqual(expect.any(String));
    expect(["Pending", "Running"]).toContain(created.status.state);

    try {
      const endpoint = await client.getEndpoint(created.id);
      await expect(client.ping(endpoint)).resolves.toBeUndefined();
      const unauthenticated = await fetch(`${endpoint.endpoint.replace(/\/$/, "")}/ping`, {
        headers: {
          ...endpoint.headers,
          "OPEN-SANDBOX-API-KEY": process.env.OIK_SECRET_OPENSANDBOX_API_KEY as string,
        },
      });
      expect(unauthenticated.status).toBe(401);
      await expect(client.runCommand(endpoint, { command: "echo hello" })).resolves.toEqual({
        stdout: expect.stringContaining("hello"),
        stderr: "",
        exitCode: 0,
      });
    } finally {
      await client.destroySandbox(created.id);
    }
  }, 30_000);
});
