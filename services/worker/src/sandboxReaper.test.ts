/**
 * TASK-296 — integration coverage for the sandbox reaper against a real
 * Postgres (DATABASE_URL-gated, same `describe.skip` convention every other
 * live-DB suite in this repo uses — see `packages/db/src/roles.test.ts`).
 * Run ONLY via `scripts/test-isolated.ps1` per this task's own Acceptance
 * Criteria (never a direct `DATABASE_URL`, per the 2026-09-15 production
 * -spend incident referenced there).
 *
 * A fake `SandboxClient` is used throughout — never a real OpenSandbox call
 * — so these tests exercise the reaper's DB-driven decision logic and its
 * consumption of `listSandboxes`/`destroySandbox`/`pauseSandbox` without
 * touching the live clawsrv deployment.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRole,
  defaultPoolConfig,
  getRoleSandbox,
  updateRoleStatus,
  upsertRoleSandbox,
  type DatabaseOptions,
} from "@oikonomos/db";
import {
  createSandboxClient,
  SandboxClientError,
  type Sandbox,
  type SandboxClient,
} from "@oikonomos/sandbox-client";

import {
  createSandboxReaperScheduler,
  runSandboxReaperSweep,
  withSandboxRelease,
} from "./sandboxReaper.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("sandboxReaper — real DB, fake SandboxClient (TASK-296)", () => {
  const db: DatabaseOptions = { connectionString: connectionString! };
  let pool: Pool;
  let tenantCounter = 0;
  // Each test gets its OWN tenant: `runSandboxReaperSweep`'s Pass 1 scans
  // every role in the given tenant, so two tests sharing one tenant would
  // see each other's roles (and re-process an already-reaped one from an
  // earlier test) — a real cross-test interference bug this suite hit
  // during development, not a hypothetical.
  function freshTenant(label: string): string {
    tenantCounter += 1;
    return `task-296-${label}-${tenantCounter}`;
  }

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM role_sandboxes WHERE role_id LIKE 'task-296-%'`);
    await pool.query(`DELETE FROM roles WHERE tenant_id LIKE 'task-296-%' OR role_id LIKE 'task-296-%'`);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  /** Backdates last_used_at directly — upsertRoleSandbox/updateRoleSandboxState always write now(). */
  async function backdateLastUsed(roleId: string, msAgo: number): Promise<void> {
    await pool.query(
      `UPDATE role_sandboxes SET last_used_at = now() - ($2 || ' milliseconds')::interval WHERE role_id = $1`,
      [roleId, String(msAgo)],
    );
  }

  function fakeClient(overrides: Partial<SandboxClient> = {}): SandboxClient & {
    readonly destroyed: string[];
  } {
    const destroyed: string[] = [];
    return {
      health: async () => ({ status: "ok" }),
      createSandbox: async () => { throw new Error("not used in this suite"); },
      getSandbox: async (id: string) => ({ id, createdAt: new Date().toISOString(), status: { state: "Running" } }),
      destroySandbox: async (id: string) => { destroyed.push(id); },
      pauseSandbox: async () => undefined,
      resumeSandbox: async () => undefined,
      getEndpoint: async () => ({ endpoint: "http://execd.test/296" }),
      ping: async () => undefined,
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      listSandboxes: async () => ({ items: [], pagination: { page: 1, pageSize: 200, totalItems: 0, totalPages: 1, hasNextPage: false } }),
      destroyed,
      ...overrides,
    };
  }

  it("reaps an active role's office once it has been idle past the threshold", async () => {
    const tenantId = freshTenant("idle");
    const roleId = "task-296-idle-role";
    await createRole(db, { roleId, tenantId, name: "Idle", title: "Idle role" });
    await upsertRoleSandbox(db, { roleId, sandboxId: "sandbox-idle", state: "Paused", execdTokenRef: "secret://x" });
    await backdateLastUsed(roleId, 10 * 24 * 60 * 60_000); // 10 days ago

    const client = fakeClient();
    const summary = await runSandboxReaperSweep(db, client, { tenantId, idleThresholdMs: 3 * 24 * 60 * 60_000 });

    expect(client.destroyed).toEqual(["sandbox-idle"]);
    expect(summary.reapedIdle).toBe(1);
    expect(summary.reapedDeletedRole).toBe(0);
    expect((await getRoleSandbox(db, roleId))?.state).toBe("Terminated");
  });

  it("does NOT reap an active role's office that was used recently, even if it was created long ago", async () => {
    const tenantId = freshTenant("fresh");
    const roleId = "task-296-fresh-role";
    await createRole(db, { roleId, tenantId, name: "Fresh", title: "Fresh role" });
    await upsertRoleSandbox(db, { roleId, sandboxId: "sandbox-fresh", state: "Paused", execdTokenRef: "secret://x" });
    // last_used_at defaults to now() on upsert — no backdating: this is the
    // "old-but-actively-used office is NOT reaped" acceptance criterion.

    const client = fakeClient();
    const summary = await runSandboxReaperSweep(db, client, { tenantId, idleThresholdMs: 3 * 24 * 60 * 60_000 });

    expect(client.destroyed).toEqual([]);
    expect(summary.reapedIdle).toBe(0);
    expect((await getRoleSandbox(db, roleId))?.state).toBe("Paused");
  });

  it("reaps a soft-deleted role's office regardless of last_used_at", async () => {
    const tenantId = freshTenant("deleted");
    const roleId = "task-296-deleted-role";
    await createRole(db, { roleId, tenantId, name: "Deleted", title: "Deleted role" });
    await upsertRoleSandbox(db, { roleId, sandboxId: "sandbox-deleted", state: "Paused", execdTokenRef: "secret://x" });
    await updateRoleStatus(db, roleId, "deleted");

    const client = fakeClient();
    const summary = await runSandboxReaperSweep(db, client, { tenantId, idleThresholdMs: 3 * 24 * 60 * 60_000 });

    expect(client.destroyed).toEqual(["sandbox-deleted"]);
    expect(summary.reapedDeletedRole).toBe(1);
    expect(summary.reapedIdle).toBe(0);
  });

  it("reconciles a server-side orphan with no role_sandboxes row at all via metadata.roleId (the db-cleanup.mjs cascade case)", async () => {
    const tenantId = freshTenant("cascade");
    const roleId = "task-296-cascade-deleted-role";
    // Deliberately NO role row and NO role_sandboxes row — simulates
    // scripts/db-cleanup.mjs's real effect: a hard DELETE FROM roles
    // cascade-deleted role_sandboxes atomically, but the physical
    // OpenSandbox container was never told to destroy.
    const orphan: Sandbox = {
      id: "sandbox-orphan",
      createdAt: new Date().toISOString(),
      status: { state: "Paused" },
      metadata: { roleId },
    };
    const client = fakeClient({
      listSandboxes: async () => ({ items: [orphan], pagination: { page: 1, pageSize: 200, totalItems: 1, totalPages: 1, hasNextPage: false } }),
    });

    const summary = await runSandboxReaperSweep(db, client, { tenantId, idleThresholdMs: 3 * 24 * 60 * 60_000 });

    expect(client.destroyed).toEqual(["sandbox-orphan"]);
    expect(summary.reconciledOrphans).toBe(1);
  });

  it("never touches a server-side sandbox whose metadata.roleId names a live role", async () => {
    const tenantId = freshTenant("live-orphan");
    const roleId = "task-296-live-orphan-check";
    await createRole(db, { roleId, tenantId, name: "Live", title: "Live role" });
    const stillLive: Sandbox = {
      id: "sandbox-still-live",
      createdAt: new Date().toISOString(),
      status: { state: "Running" },
      metadata: { roleId },
    };
    const client = fakeClient({
      listSandboxes: async () => ({ items: [stillLive], pagination: { page: 1, pageSize: 200, totalItems: 1, totalPages: 1, hasNextPage: false } }),
    });

    const summary = await runSandboxReaperSweep(db, client, { tenantId, idleThresholdMs: 3 * 24 * 60 * 60_000 });

    expect(client.destroyed).toEqual([]);
    expect(summary.reconciledOrphans).toBe(0);
  });

  it("a sweep error on one role never aborts the rest of the sweep", async () => {
    const tenantId = freshTenant("sweep-error");
    const badRoleId = "task-296-destroy-fails";
    const goodRoleId = "task-296-destroy-succeeds";
    await createRole(db, { roleId: badRoleId, tenantId, name: "Bad", title: "Bad role" });
    await upsertRoleSandbox(db, { roleId: badRoleId, sandboxId: "sandbox-bad", state: "Paused", execdTokenRef: "secret://x" });
    await updateRoleStatus(db, badRoleId, "deleted");
    await createRole(db, { roleId: goodRoleId, tenantId, name: "Good", title: "Good role" });
    await upsertRoleSandbox(db, { roleId: goodRoleId, sandboxId: "sandbox-good", state: "Paused", execdTokenRef: "secret://x" });
    await updateRoleStatus(db, goodRoleId, "deleted");

    const client = fakeClient({
      destroySandbox: async (id: string) => {
        if (id === "sandbox-bad") throw new SandboxClientError("server exploded", "UNEXPECTED_STATUS", { status: 500 });
      },
    });

    const summary = await runSandboxReaperSweep(db, client, { tenantId, idleThresholdMs: 3 * 24 * 60 * 60_000 });

    expect(summary.errors).toBe(1);
    expect(summary.reapedDeletedRole).toBe(1); // the good one still got reaped
    expect((await getRoleSandbox(db, goodRoleId))?.state).toBe("Terminated");
    // The bad one is untouched (destroy threw before updateRoleSandboxState ran) — proves the error was isolated, not swallowed silently into a false "reaped" count.
    expect((await getRoleSandbox(db, badRoleId))?.state).toBe("Paused");
  });

  it("a 404 from destroySandbox (already gone) still counts as a successful reap, not an error", async () => {
    const tenantId = freshTenant("already-gone");
    const roleId = "task-296-already-gone";
    await createRole(db, { roleId, tenantId, name: "Gone", title: "Already gone" });
    await upsertRoleSandbox(db, { roleId, sandboxId: "sandbox-already-gone", state: "Paused", execdTokenRef: "secret://x" });
    await updateRoleStatus(db, roleId, "deleted");

    const client = fakeClient({
      destroySandbox: async () => { throw new SandboxClientError("gone", "UNEXPECTED_STATUS", { status: 404 }); },
    });

    const summary = await runSandboxReaperSweep(db, client, { tenantId, idleThresholdMs: 3 * 24 * 60 * 60_000 });

    expect(summary.errors).toBe(0);
    expect(summary.reapedDeletedRole).toBe(1);
  });

  it("withSandboxRelease releases the office in a finally even when the wrapped turn throws, against the real DB", async () => {
    const tenantId = freshTenant("release-throw");
    const roleId = "task-296-release-throw";
    await createRole(db, { roleId, tenantId, name: "Release", title: "Release on failure" });
    await upsertRoleSandbox(db, { roleId, sandboxId: "sandbox-release", state: "Running", execdTokenRef: "secret://x" });

    const paused: string[] = [];
    const client = fakeClient({ pauseSandbox: async (id: string) => { paused.push(id); } });

    await expect(
      withSandboxRelease(client, db, roleId, "sandbox-release", () => Promise.reject(new Error("turn failed"))),
    ).rejects.toThrow("turn failed");

    expect(paused).toEqual(["sandbox-release"]);
    expect((await getRoleSandbox(db, roleId))?.state).toBe("Paused");
  });

  it("withSandboxRelease releases on the success path too and returns the run's value", async () => {
    const tenantId = freshTenant("release-success");
    const roleId = "task-296-release-success";
    await createRole(db, { roleId, tenantId, name: "ReleaseOk", title: "Release on success" });
    await upsertRoleSandbox(db, { roleId, sandboxId: "sandbox-release-ok", state: "Running", execdTokenRef: "secret://x" });

    const paused: string[] = [];
    const client = fakeClient({ pauseSandbox: async (id: string) => { paused.push(id); } });

    const result = await withSandboxRelease(client, db, roleId, "sandbox-release-ok", async () => "turn-result");

    expect(result).toBe("turn-result");
    expect(paused).toEqual(["sandbox-release-ok"]);
    expect((await getRoleSandbox(db, roleId))?.state).toBe("Paused");
  });

  it("createSandboxClient's real listSandboxes builds the documented query string and parses a real response shape (TASK-296 — the one direct HTTP-shape test this method gets, since packages/sandbox-client/test/** is outside this task's Owned_Paths)", async () => {
    const seenRequests: Array<{ path: string }> = [];
    const client = createSandboxClient({
      baseUrl: "http://sandbox.test",
      resolveApiKey: async () => "fake-key",
      fetchImpl: async (input) => {
        seenRequests.push({ path: String(input) });
        return new Response(
          JSON.stringify({
            items: [{ id: "sbx-1", createdAt: "2026-09-18T00:00:00Z", status: { state: "Running" }, metadata: { roleId: "r1" } }],
            pagination: { page: 2, pageSize: 50, totalItems: 3, totalPages: 3, hasNextPage: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const response = await client.listSandboxes!({ state: ["Running", "Paused"], page: 2, pageSize: 50 });

    expect(seenRequests[0]?.path).toBe(
      "http://sandbox.test/v1/sandboxes?state=Running&state=Paused&page=2&pageSize=50",
    );
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.metadata?.roleId).toBe("r1");
    expect(response.pagination.hasNextPage).toBe(true);
  });

  it("the scheduler's liveness assertion: a real interval tick emits non-zero sweep evidence, not just 'didn't throw' (ADR-005)", async () => {
    const tenantId = freshTenant("liveness");
    const roleId = "task-296-liveness-role";
    await createRole(db, { roleId, tenantId, name: "Liveness", title: "Liveness role" });
    await upsertRoleSandbox(db, { roleId, sandboxId: "sandbox-liveness", state: "Paused", execdTokenRef: "secret://x" });
    await backdateLastUsed(roleId, 10 * 24 * 60 * 60_000);

    const client = fakeClient();
    const summaries: Array<{ reapedIdle: number; reapedDeletedRole: number; reconciledOrphans: number }> = [];
    const scheduler = createSandboxReaperScheduler({
      ...db,
      tenantId,
      client,
      intervalMs: 20_000, // never fires again during this test; only the immediate boot-tick matters
      idleThresholdMs: 3 * 24 * 60 * 60_000,
      onSweep: (summary) => summaries.push(summary),
      onError: (error) => { throw error; },
    });

    try {
      scheduler.start();
      // The immediate boot-tick is async; give it a real turn of the loop.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(summaries.length).toBeGreaterThanOrEqual(1);
      // The liveness evidence itself: a control that silently no-ops every
      // time is indistinguishable from one that never ran unless something
      // asserts on real, non-zero counts the sweep emits by doing its job.
      expect(summaries[0]?.reapedIdle).toBe(1);
      expect(client.destroyed).toContain("sandbox-liveness");
    } finally {
      scheduler.stop();
    }
  });
});
