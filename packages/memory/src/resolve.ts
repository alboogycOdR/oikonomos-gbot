import { getAgentFact, getProjectFact, getUserFact } from "./facts.js";
import { requireNonEmpty, type DatabaseOptions } from "./database.js";
import type { MemoryContext, MemoryFact, MemoryScope } from "./types.js";

/**
 * The probe's conflict order (F6): agent > project > user. Pure function —
 * no I/O, no dependency on `Date.now()` beyond what's already baked into
 * the candidates it's handed — so it is directly unit-testable and its
 * ordering is exactly what "MUTATION-PROVEN: inverting the conflict order
 * turns a resolve test RED" exercises.
 */
const CONFLICT_ORDER: readonly MemoryScope[] = ["agent", "project", "user"];

export function resolveConflict(
  candidates: readonly (MemoryFact | null | undefined)[],
): MemoryFact | null {
  const bySc = new Map<MemoryScope, MemoryFact>();
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined) {
      bySc.set(candidate.scope, candidate);
    }
  }
  for (const scope of CONFLICT_ORDER) {
    const found = bySc.get(scope);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

/**
 * Fetch the agent/project/user candidates for `key` under `ctx` and apply
 * `resolveConflict`. Agent/project lookups are skipped when `ctx` carries no
 * roleId/projectId respectively — there is nothing to look up, not a
 * cross-role read, so this never queries another role's agent-scope row.
 */
export async function resolve(
  options: DatabaseOptions,
  ctx: MemoryContext,
  key: string,
): Promise<MemoryFact | null> {
  const tenantId = requireNonEmpty(ctx.tenantId, "tenantId");
  const normalizedKey = requireNonEmpty(key, "key");

  const [agent, project, user] = await Promise.all([
    ctx.roleId !== undefined
      ? getAgentFact(options, { tenantId, roleId: ctx.roleId }, normalizedKey)
      : Promise.resolve(null),
    ctx.projectId !== undefined
      ? getProjectFact(options, { tenantId, projectId: ctx.projectId }, normalizedKey)
      : Promise.resolve(null),
    getUserFact(options, { tenantId }, normalizedKey),
  ]);

  return resolveConflict([agent, project, user]);
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  function fact(scope: MemoryScope, value: string): MemoryFact {
    return {
      factId: `${scope}-fact`,
      tenantId: "t",
      scope,
      roleId: scope === "agent" ? "role-a" : null,
      projectId: scope === "project" ? "proj-a" : null,
      key: "k",
      value,
      source: "test",
      confidence: 0.8,
      tier: "profile",
      expiresAt: null,
    };
  }

  describe("@oikonomos/memory resolveConflict — agent > project > user (pure)", () => {
    it("returns the agent-scope value when all three scopes hold the key", () => {
      const result = resolveConflict([fact("agent", "A"), fact("project", "P"), fact("user", "U")]);
      expect(result?.value).toBe("A");
    });

    it("returns the project-scope value when agent is absent", () => {
      const result = resolveConflict([null, fact("project", "P"), fact("user", "U")]);
      expect(result?.value).toBe("P");
    });

    it("returns the user-scope value when both agent and project are absent", () => {
      const result = resolveConflict([null, undefined, fact("user", "U")]);
      expect(result?.value).toBe("U");
    });

    it("returns null when no candidate holds the key", () => {
      expect(resolveConflict([null, null, null])).toBeNull();
    });

    it("rejects an empty tenantId/key on resolve()", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(resolve(live, { tenantId: "  " }, "k")).rejects.toThrow(/tenantId/);
      await expect(resolve(live, { tenantId: "t" }, "  ")).rejects.toThrow(/key/);
    });
  });
}
