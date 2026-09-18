/**
 * TASK-296 — closes the CODE half of the TASK-292 incident (97 leaked
 * egress containers on clawsrv). Offices are deliberately PERSISTENT per
 * role (ADR-010) — nothing here destroys an office just because a turn
 * ended. This module exists for the two ways a persistent office still
 * needs to die:
 *
 * 1. **The role it belongs to is gone or genuinely idle.** A hard-deleted
 *    role (`scripts/db-cleanup.mjs`, `DELETE FROM roles`) cascade-deletes
 *    its `role_sandboxes` row atomically (`role_sandboxes.role_id
 *    REFERENCES roles(role_id) ON DELETE CASCADE`,
 *    `018_role_sandboxes.up.sql`) — there is no row left to iterate, so
 *    that class is handled entirely by reconciliation (§2 below), never by
 *    this pass. What THIS pass catches is the two cases where a row
 *    survives: a role soft-deleted via `retireRole`/`updateRoleStatus`
 *    (`roles.status = 'deleted'`, FK-intact, no cascade fires), and a role
 *    that is still perfectly alive but whose office has sat unused past
 *    the idle window (`role_sandboxes.last_used_at`, indexed and written
 *    by every `upsertRoleSandbox`/`updateRoleSandboxState` call, but never
 *    read by anything before this task).
 *
 * 2. **The server has a sandbox our own DB has no way to find.** Exactly
 *    the cascade case above — the container `db-cleanup.mjs` never told
 *    OpenSandbox to destroy. `resolveRoleSandbox` (`chatRunDriver.ts`)
 *    always sets `metadata.roleId` at creation, so reconciliation lists the
 *    server's own sandboxes (`SandboxClient.listSandboxes`, TASK-296) and
 *    destroys any whose `metadata.roleId` now names a missing or
 *    soft-deleted role — independent of `role_sandboxes` entirely, which
 *    is what makes it able to see a row that was never there to begin with.
 *
 * **Deliberately composed from already-exported `@oikonomos/db` primitives
 * (`listRoles`, `getRole`, `getRoleSandbox`, `updateRoleSandboxState`)
 * rather than a new bulk "list every `role_sandboxes` row" query.** Adding
 * one would need a matching export from `packages/db/src/index.ts`, the
 * package barrel — outside this task's `Owned_Paths`, and a file no other
 * part of this task has a legitimate reason to touch. Iterating tenant
 * roles and looking up each one's office is one extra round trip per role
 * instead of a single join; acceptable for a periodic maintenance sweep
 * that is never on any request's hot path.
 */
import {
  getRole,
  getRoleSandbox,
  listRoles,
  updateRoleSandboxState,
  type DatabaseOptions,
  type Role,
  type RoleSandbox,
} from "@oikonomos/db";
import { SandboxClientError, type Sandbox, type SandboxClient, type SandboxState } from "@oikonomos/sandbox-client";

/**
 * How long an active role's office may sit unused before the sweep treats
 * it as leaked rather than "in daily use" (TASK-296 AC1). Long enough that
 * a role idle over a weekend, or one used only a few times a week, is never
 * falsely reaped — an old `created_at` alone never qualifies, only a stale
 * `last_used_at` does, so a long-lived office in genuine periodic use
 * survives indefinitely. Short enough that a leaked office from an
 * abandoned test role or a crashed run doesn't sit consuming clawsrv
 * resources for weeks. Override with `OIK_SANDBOX_REAPER_IDLE_MS` for ops
 * tuning without a redeploy.
 */
export const DEFAULT_SANDBOX_IDLE_MS = 3 * 24 * 60 * 60_000; // 3 days

/**
 * How often the in-process scheduler sweeps. Frequent enough that a leak
 * introduced by a crash is caught within a fraction of the idle window
 * above (never the sole line of defence against it); infrequent enough
 * that it never meaningfully contends with real chat-turn traffic against
 * the same OpenSandbox API. Override with `OIK_SANDBOX_REAPER_INTERVAL_MS`.
 */
export const DEFAULT_SANDBOX_REAP_INTERVAL_MS = 15 * 60_000; // 15 minutes

const TERMINAL_SANDBOX_STATES: ReadonlySet<SandboxState> = new Set(["Terminated", "Failed"]);
/** `role_sandboxes.state` uses the same vocabulary as `SandboxState` (`roleSandboxStates`, packages/db). */
const TERMINAL_ROLE_SANDBOX_STATES: ReadonlySet<string> = TERMINAL_SANDBOX_STATES;

export interface SandboxSweepSummary {
  /** ISO-8601 timestamp the sweep completed — the liveness evidence a test/operator reads, never a bare mtime (ADR-005 §5). */
  readonly sweptAt: string;
  readonly rolesScanned: number;
  readonly reapedIdle: number;
  readonly reapedDeletedRole: number;
  readonly reconciledOrphans: number;
  /** Individual per-office failures during the sweep — never aborts the whole pass (one bad row must not block every other reap). */
  readonly errors: number;
}

export interface SandboxReaperSweepConfig {
  readonly tenantId: string;
  readonly idleThresholdMs?: number;
}

function reapReasonFor(role: Role, record: RoleSandbox, idleBeforeMs: number): "idle" | "deleted" | undefined {
  if (role.status === "deleted") return "deleted";
  if (record.lastUsedAt.getTime() < idleBeforeMs) return "idle";
  return undefined;
}

/** A 404 means the office is already gone — treat that as success, not a sweep error. */
async function destroySandboxIfLive(client: SandboxClient, sandboxId: string): Promise<void> {
  try {
    await client.destroySandbox(sandboxId);
  } catch (error) {
    if (error instanceof SandboxClientError && error.status === 404) return;
    throw error;
  }
}

/**
 * Pages through every sandbox the server currently knows about (page
 * 1..N). `listSandboxes` is optional on `SandboxClient` (see that
 * interface's own comment) — a client that lacks it yields nothing, so
 * orphan reconciliation degrades to a no-op for that caller rather than
 * throwing. The real production client always implements it.
 */
async function* listAllSandboxes(client: SandboxClient): AsyncGenerator<Sandbox> {
  if (client.listSandboxes === undefined) return;
  const listSandboxes = client.listSandboxes.bind(client);
  let page = 1;
  const pageSize = 200; // server-documented maximum (openapi.json, verified live 2026-09-18)
  for (;;) {
    const response = await listSandboxes({ page, pageSize });
    for (const item of response.items) yield item;
    if (!response.pagination.hasNextPage) return;
    page += 1;
  }
}

/**
 * Runs one sweep to completion and returns a summary. This return value IS
 * the liveness evidence (ADR-005): a control that silently no-ops every
 * time looks identical to one that never ran unless something asserts on
 * evidence the control emits by doing its job. `sandboxReaper.test.ts`
 * keys its liveness assertion on non-zero counts here, never on
 * configuration being present or the scheduler having merely started.
 */
export async function runSandboxReaperSweep(
  options: DatabaseOptions,
  client: SandboxClient,
  config: SandboxReaperSweepConfig,
): Promise<SandboxSweepSummary> {
  const idleThresholdMs = config.idleThresholdMs ?? DEFAULT_SANDBOX_IDLE_MS;
  const idleBeforeMs = Date.now() - idleThresholdMs;
  let rolesScanned = 0;
  let reapedIdle = 0;
  let reapedDeletedRole = 0;
  let reconciledOrphans = 0;
  let errors = 0;
  const handledSandboxIds = new Set<string>();

  // Pass 1 — roles this tenant still has a row for (active, hidden, OR
  // soft-deleted; listRoles with no status filter returns all three).
  const roles = await listRoles(options, { tenantId: config.tenantId });
  rolesScanned = roles.length;
  for (const role of roles) {
    try {
      const record = await getRoleSandbox(options, role.roleId);
      if (record === null) continue;
      // Already reaped by an earlier sweep (or otherwise terminal) — a
      // soft-deleted role's `status` never changes back, so without this
      // skip every future sweep would re-"reap" (and re-hit the real
      // OpenSandbox API for) the same already-gone office forever, forever
      // inflating the liveness evidence with no new work actually done.
      if (TERMINAL_ROLE_SANDBOX_STATES.has(record.state)) continue;
      const reason = reapReasonFor(role, record, idleBeforeMs);
      if (reason === undefined) continue;
      await destroySandboxIfLive(client, record.sandboxId);
      handledSandboxIds.add(record.sandboxId);
      // Reflect reality immediately: the next resolveRoleSandbox call for
      // an idle-reaped (still-active) role sees a Terminated record and
      // must recreate rather than trust a live-looking stale row.
      await updateRoleSandboxState(options, role.roleId, "Terminated");
      if (reason === "idle") reapedIdle += 1; else reapedDeletedRole += 1;
    } catch (error) {
      errors += 1;
      console.error(`sandbox reaper: failed reaping role ${role.roleId}:`, error);
    }
  }

  // Pass 2 — reconcile the server's own sandbox list against role state
  // directly. This is the ONLY path that finds a cascade-deleted role's
  // orphaned container: pass 1 iterates roles, and a hard-deleted role's
  // role_sandboxes row is already gone by the time this runs.
  for await (const sandbox of listAllSandboxes(client)) {
    if (handledSandboxIds.has(sandbox.id)) continue;
    if (TERMINAL_SANDBOX_STATES.has(sandbox.status.state)) continue;
    const roleId = sandbox.metadata?.roleId;
    if (roleId === undefined || roleId.trim().length === 0) continue; // not one of ours
    try {
      const role = await getRole(options, roleId);
      if (role !== null && role.status !== "deleted") continue; // live role — reconciliation never touches it
      await destroySandboxIfLive(client, sandbox.id);
      handledSandboxIds.add(sandbox.id);
      reconciledOrphans += 1;
    } catch (error) {
      errors += 1;
      console.error(`sandbox reaper: failed reconciling orphan sandbox ${sandbox.id}:`, error);
    }
  }

  return {
    sweptAt: new Date().toISOString(),
    rolesScanned,
    reapedIdle,
    reapedDeletedRole,
    reconciledOrphans,
    errors,
  };
}

/**
 * Release-on-failure (TASK-296 AC3). Both chat lanes call this around the
 * one operation that actually runs inside the office — the Claude lane's
 * `runCommand`, the Gemini lane's `adapter.run` — so a thrown error
 * (network failure, broker denial, a tool crash) can never leave the
 * office Running/Resuming forever. Before this fix the Claude lane only
 * paused after a successful command AND after the exit-code check (both
 * of which could throw first); the Gemini lane never paused at all.
 *
 * Release failures are logged, not rethrown: surfacing a secondary
 * release failure would mask the run's own real error, and the idle sweep
 * above is the backstop if release genuinely fails here.
 */
export async function withSandboxRelease<T>(
  client: SandboxClient,
  options: DatabaseOptions,
  roleId: string,
  sandboxId: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    try {
      await client.pauseSandbox(sandboxId);
      await updateRoleSandboxState(options, roleId, "Paused");
    } catch (releaseError) {
      console.error(`sandbox reaper: failed to release office for role ${roleId} after a turn:`, releaseError);
    }
  }
}

export interface SandboxReaperSchedulerOptions extends DatabaseOptions {
  readonly client: SandboxClient;
  readonly tenantId: string;
  readonly intervalMs?: number;
  readonly idleThresholdMs?: number;
  /** Fires after every completed sweep, success or not — the liveness hook a caller (main.ts, or a test) observes. */
  readonly onSweep?: (summary: SandboxSweepSummary) => void;
  readonly onError?: (error: unknown) => void;
}

export interface SandboxReaperScheduler {
  start(): void;
  stop(): void;
}

/**
 * A plain in-process interval, not a durable pg-boss schedule like
 * `RoleMessageDeliveryPoller`: this is a maintenance sweep over state that
 * only changes while a worker is running chat turns in the first place, so
 * there is nothing to catch up on across a restart the way an undelivered
 * message needs to be. `intervalMs` is `unref()`'d so the reaper never
 * itself keeps the worker process alive.
 */
export function createSandboxReaperScheduler(options: SandboxReaperSchedulerOptions): SandboxReaperScheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;

  const tick = async (): Promise<void> => {
    if (sweeping) return; // never let a slow sweep overlap the next tick
    sweeping = true;
    try {
      const summary = await runSandboxReaperSweep(options, options.client, {
        tenantId: options.tenantId,
        idleThresholdMs: options.idleThresholdMs,
      });
      options.onSweep?.(summary);
    } catch (error) {
      options.onError?.(error);
    } finally {
      sweeping = false;
    }
  };

  return {
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => { void tick(); }, options.intervalMs ?? DEFAULT_SANDBOX_REAP_INTERVAL_MS);
      timer.unref?.();
      void tick(); // run one sweep immediately at boot rather than waiting a full interval
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

if (import.meta.vitest) {
  const { describe, expect, it, vi } = import.meta.vitest;

  function fakeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
    return { id: "sandbox-1", createdAt: "2026-09-01T00:00:00Z", status: { state: "Running" }, ...overrides };
  }

  describe("sandboxReaper — pure helpers (no DB)", () => {
    it("destroySandboxIfLive swallows a 404 (already gone) but rethrows anything else", async () => {
      const notFound = { destroySandbox: vi.fn().mockRejectedValue(new SandboxClientError("gone", "UNEXPECTED_STATUS", { status: 404 })) };
      await expect(destroySandboxIfLive(notFound as unknown as SandboxClient, "x")).resolves.toBeUndefined();

      const serverError = { destroySandbox: vi.fn().mockRejectedValue(new SandboxClientError("boom", "UNEXPECTED_STATUS", { status: 500 })) };
      await expect(destroySandboxIfLive(serverError as unknown as SandboxClient, "x")).rejects.toThrow("boom");
    });

    it("listAllSandboxes pages through every result before stopping", async () => {
      const listSandboxes = vi
        .fn()
        .mockResolvedValueOnce({ items: [fakeSandbox({ id: "a" })], pagination: { page: 1, pageSize: 1, totalItems: 2, totalPages: 2, hasNextPage: true } })
        .mockResolvedValueOnce({ items: [fakeSandbox({ id: "b" })], pagination: { page: 2, pageSize: 1, totalItems: 2, totalPages: 2, hasNextPage: false } });
      const client = { listSandboxes } as unknown as SandboxClient;
      const ids: string[] = [];
      for await (const sandbox of listAllSandboxes(client)) ids.push(sandbox.id);
      expect(ids).toEqual(["a", "b"]);
      expect(listSandboxes).toHaveBeenCalledTimes(2);
    });
  });

  // `withSandboxRelease` itself calls the real `updateRoleSandboxState`
  // (@oikonomos/db) inside its `finally`, so proving its release-on-throw
  // behaviour against the REAL function (not a hand-copied stand-in) needs
  // a real database — see the DATABASE_URL-gated integration suite in
  // `sandboxReaper.test.ts` for that coverage.
}
