import type { QueryResultRow } from "pg";

import { requireNonEmpty, withPool, type DatabaseOptions } from "./database.js";
import {
  DEFAULT_NOTE_TTL_MS,
  memoryScopes,
  memoryTiers,
  type MemoryContext,
  type MemoryFact,
  type MemoryScope,
  type MemoryTier,
  type NewMemoryFact,
} from "./types.js";

const factColumns = `fact_id, tenant_id, scope, role_id, project_id, key, value, source, confidence, tier, expires_at, visible_to, superseded_by`;

interface FactRow extends QueryResultRow {
  fact_id: string;
  tenant_id: string;
  scope: MemoryScope;
  role_id: string | null;
  project_id: string | null;
  key: string;
  value: string;
  source: string;
  confidence: number;
  tier: MemoryTier;
  expires_at: Date | null;
  visible_to: string[] | null;
  superseded_by: string | null;
}

function toFact(row: FactRow): MemoryFact {
  return {
    factId: row.fact_id,
    tenantId: row.tenant_id,
    scope: row.scope,
    roleId: row.role_id,
    projectId: row.project_id,
    key: row.key,
    value: row.value,
    source: row.source,
    confidence: row.confidence,
    tier: row.tier,
    expiresAt: row.expires_at,
    visibleTo: row.visible_to,
    supersededBy: row.superseded_by,
  };
}

function normalizeVisibleTo(value: readonly string[] | undefined): string[] | null {
  if (value === undefined) return null;
  const normalized = value.map((roleId) => requireNonEmpty(roleId, "visibleTo roleId"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("visibleTo must not contain duplicate roleIds.");
  }
  return normalized;
}

function requireScope(value: MemoryScope, field: string): MemoryScope {
  if (!memoryScopes.includes(value)) {
    throw new Error(`${field} must be one of: ${memoryScopes.join(", ")}.`);
  }
  return value;
}

function requireTier(value: MemoryTier, field: string): MemoryTier {
  if (!memoryTiers.includes(value)) {
    throw new Error(`${field} must be one of: ${memoryTiers.join(", ")}.`);
  }
  return value;
}

/**
 * Explicit, audited write. Nothing in this module (or the rest of the
 * package) writes a fact as a side effect of a read or a resolve() call —
 * this is the ONLY function that performs an INSERT/UPDATE against
 * profile_facts (probe Q5).
 *
 * Validation happens entirely before any query executes, so a rejected
 * write never touches the database (AC: "a failed write leaves the store
 * unchanged").
 */
export async function writeMemoryFact(
  options: DatabaseOptions,
  input: NewMemoryFact,
): Promise<MemoryFact> {
  const scope = requireScope(input.scope, "scope");
  const key = requireNonEmpty(input.key, "key");
  const value = requireNonEmpty(input.value, "value");
  const source = requireNonEmpty(input.source, "source");
  const tier = requireTier(input.tier ?? "profile", "tier");
  const confidence = input.confidence ?? 0.8;
  const tenantId = input.tenantId ?? "basileia";

  // Mirror the DB CHECK (scope = 'agent') = (role_id IS NOT NULL) here so a
  // bad call fails with a clear message before ever reaching the pool.
  if (scope === "agent") {
    input.roleId = requireNonEmpty(input.roleId ?? "", "roleId (required for scope='agent')");
  } else if (input.roleId !== undefined && input.roleId.trim().length > 0) {
    throw new Error(`roleId must not be set for scope='${scope}' (only 'agent' scope carries a roleId).`);
  }

  const roleId = scope === "agent" ? (input.roleId ?? null) : null;
  // ACLs deliberately apply only to tenant-shared project/user facts.  An
  // agent fact is still readable only by its owner, so a supplied ACL cannot
  // alter that invariant (and is not persisted as an accidental policy hint).
  const visibleTo = scope === "agent" ? null : normalizeVisibleTo(input.visibleTo);
  const projectId = scope === "project" ? (input.projectId ?? null) : null;
  if (scope === "project" && (projectId === null || projectId.trim().length === 0)) {
    throw new Error("projectId (required for scope='project')");
  }

  let expiresAt: Date | null = null;
  if (tier === "note") {
    const ttlMs = input.ttlMs ?? DEFAULT_NOTE_TTL_MS;
    if (ttlMs <= 0) {
      throw new Error("ttlMs must be positive.");
    }
    expiresAt = new Date(Date.now() + ttlMs);
  } else if (input.ttlMs !== undefined) {
    throw new Error("ttlMs is only meaningful for tier='note'.");
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<FactRow>(
      `WITH locked AS (
         SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':' || COALESCE($3, '') || ':' || COALESCE($4, '') || ':' || $5, 0))
       ), inserted AS (
         INSERT INTO profile_facts (tenant_id, scope, role_id, project_id, key, value, source, confidence, tier, expires_at, visible_to)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11 FROM locked
         RETURNING ${factColumns}
       ), superseded AS (
         UPDATE profile_facts SET superseded_by = (SELECT fact_id FROM inserted)
         WHERE tenant_id = $1 AND scope = $2 AND role_id IS NOT DISTINCT FROM $3
           AND project_id IS NOT DISTINCT FROM $4 AND key = $5
           AND fact_id <> (SELECT fact_id FROM inserted) AND superseded_by IS NULL
       )
       SELECT ${factColumns} FROM inserted`,
      [tenantId, scope, roleId, projectId, key, value, source, confidence, tier, expiresAt, visibleTo],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("writeMemoryFact did not return a persisted row.");
    }
    return toFact(row);
  });
}

/** Excludes expired notes (expires_at in the past) from every read below. */
const NOT_EXPIRED = `(expires_at IS NULL OR expires_at > now())`;
const CURRENT = `superseded_by IS NULL`;
const VISIBLE_TO_CALLER = `(visible_to IS NULL OR $2 = ANY(visible_to))`;

/**
 * Look up the agent-scope fact for exactly the caller's own role_id.
 * There is deliberately no variant of this function that accepts an
 * arbitrary role_id from a different caller's context — the only role_id
 * ever placed in the WHERE clause is the one the caller passed as its own
 * identity, so role A can never be handed role B's agent-scope row through
 * this API (F6 "a role cannot read another role's agent-scope memory at
 * all").
 */
export async function getAgentFact(
  options: DatabaseOptions,
  ctx: { tenantId: string; roleId: string },
  key: string,
): Promise<MemoryFact | null> {
  const tenantId = requireNonEmpty(ctx.tenantId, "tenantId");
  const roleId = requireNonEmpty(ctx.roleId, "roleId");
  const normalizedKey = requireNonEmpty(key, "key");

  return withPool(options, async (pool) => {
    const result = await pool.query<FactRow>(
      `SELECT ${factColumns} FROM profile_facts
       WHERE tenant_id = $1 AND scope = 'agent' AND role_id = $2 AND key = $3 AND ${NOT_EXPIRED} AND ${CURRENT}`,
      [tenantId, roleId, normalizedKey],
    );
    return result.rows[0] === undefined ? null : toFact(result.rows[0]);
  });
}

export async function getProjectFact(
  options: DatabaseOptions,
  ctx: { tenantId: string; projectId: string; roleId?: string },
  key: string,
): Promise<MemoryFact | null> {
  const tenantId = requireNonEmpty(ctx.tenantId, "tenantId");
  const projectId = requireNonEmpty(ctx.projectId, "projectId");
  const normalizedKey = requireNonEmpty(key, "key");

  return withPool(options, async (pool) => {
    const result = await pool.query<FactRow>(
      `SELECT ${factColumns} FROM profile_facts
       WHERE tenant_id = $1 AND scope = 'project' AND project_id = $2 AND key = $3
         AND ${NOT_EXPIRED} AND ${CURRENT} AND (visible_to IS NULL OR $4 = ANY(visible_to))`,
      [tenantId, projectId, normalizedKey, ctx.roleId ?? null],
    );
    return result.rows[0] === undefined ? null : toFact(result.rows[0]);
  });
}

export async function getUserFact(
  options: DatabaseOptions,
  ctx: { tenantId: string; roleId?: string },
  key: string,
): Promise<MemoryFact | null> {
  const tenantId = requireNonEmpty(ctx.tenantId, "tenantId");
  const normalizedKey = requireNonEmpty(key, "key");

  return withPool(options, async (pool) => {
    const result = await pool.query<FactRow>(
      `SELECT ${factColumns} FROM profile_facts
       WHERE tenant_id = $1 AND scope = 'user' AND role_id IS NULL AND project_id IS NULL
         AND key = $2 AND ${NOT_EXPIRED} AND ${CURRENT} AND (visible_to IS NULL OR $3 = ANY(visible_to))`,
      [tenantId, normalizedKey, ctx.roleId ?? null],
    );
    return result.rows[0] === undefined ? null : toFact(result.rows[0]);
  });
}

/**
 * The every-turn prefix-injection reader. Returns ONLY tier='profile' rows
 * visible to this context (the caller's own agent scope, its project scope,
 * and the tenant's user scope) — `log` and `note` rows are excluded
 * unconditionally, and an expired note could never have been tier='profile'
 * anyway but the NOT_EXPIRED filter is applied for consistency.
 */
export async function readProfileTier(
  options: DatabaseOptions,
  ctx: MemoryContext,
): Promise<MemoryFact[]> {
  const tenantId = requireNonEmpty(ctx.tenantId, "tenantId");
  const conditions = [`tenant_id = $1`, `tier = 'profile'`, NOT_EXPIRED, CURRENT, VISIBLE_TO_CALLER];
  const params: unknown[] = [tenantId, ctx.roleId ?? null];
  const scopeConditions: string[] = [`scope = 'user' AND role_id IS NULL AND project_id IS NULL`];

  if (ctx.roleId !== undefined) {
    scopeConditions.push(`(scope = 'agent' AND role_id = $2)`);
  }
  if (ctx.projectId !== undefined) {
    params.push(ctx.projectId);
    scopeConditions.push(`(scope = 'project' AND project_id = $${params.length})`);
  }
  conditions.push(`(${scopeConditions.join(" OR ")})`);

  return withPool(options, async (pool) => {
    const result = await pool.query<FactRow>(
      `SELECT ${factColumns} FROM profile_facts
       WHERE ${conditions.join(" AND ")}
       ORDER BY key`,
      params,
    );
    return result.rows.map(toFact);
  });
}

/**
 * Retrieve one historical fact by id. Unlike normal key reads this permits a
 * superseded row, while preserving the same agent ownership and ACL checks.
 */
export async function getFactById(
  options: DatabaseOptions,
  ctx: { tenantId: string; roleId?: string },
  factId: string,
): Promise<MemoryFact | null> {
  const tenantId = requireNonEmpty(ctx.tenantId, "tenantId");
  const normalizedFactId = requireNonEmpty(factId, "factId");
  return withPool(options, async (pool) => {
    const result = await pool.query<FactRow>(
      `SELECT ${factColumns} FROM profile_facts
       WHERE tenant_id = $1 AND fact_id = $3 AND ${NOT_EXPIRED}
         AND ((scope = 'agent' AND role_id = $2)
           OR (scope <> 'agent' AND ${VISIBLE_TO_CALLER}))`,
      [tenantId, ctx.roleId ?? null, normalizedFactId],
    );
    return result.rows[0] === undefined ? null : toFact(result.rows[0]);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/memory facts — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        writeMemoryFact(options, { scope: "user", key: "k", value: "v", source: "s" }),
      ).rejects.toThrow(/connectionString/);
    });

    it("rejects scope='agent' with no roleId", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        writeMemoryFact(live, { scope: "agent", key: "k", value: "v", source: "s" }),
      ).rejects.toThrow(/roleId/);
    });

    it("rejects a roleId supplied for a non-agent scope", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        writeMemoryFact(live, {
          scope: "user",
          roleId: "r1",
          key: "k",
          value: "v",
          source: "s",
        }),
      ).rejects.toThrow(/roleId must not be set/);
    });

    it("rejects scope='project' with no projectId", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        writeMemoryFact(live, { scope: "project", key: "k", value: "v", source: "s" }),
      ).rejects.toThrow(/projectId/);
    });

    it("rejects an invalid scope or tier", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        writeMemoryFact(live, {
          scope: "bogus" as MemoryScope,
          key: "k",
          value: "v",
          source: "s",
        }),
      ).rejects.toThrow(/scope/);
      await expect(
        writeMemoryFact(live, {
          scope: "user",
          key: "k",
          value: "v",
          source: "s",
          tier: "bogus" as MemoryTier,
        }),
      ).rejects.toThrow(/tier/);
    });

    it("rejects a non-positive explicit ttlMs, and a ttlMs on a non-note tier", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        writeMemoryFact(live, {
          scope: "user",
          key: "k",
          value: "v",
          source: "s",
          tier: "note",
          ttlMs: 0,
        }),
      ).rejects.toThrow(/ttlMs/);
      await expect(
        writeMemoryFact(live, {
          scope: "user",
          key: "k",
          value: "v",
          source: "s",
          tier: "profile",
          ttlMs: 1000,
        }),
      ).rejects.toThrow(/ttlMs/);
    });

    it("rejects empty key/value/source on writeMemoryFact", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        writeMemoryFact(live, { scope: "user", key: "  ", value: "v", source: "s" }),
      ).rejects.toThrow(/key/);
      await expect(
        writeMemoryFact(live, { scope: "user", key: "k", value: "  ", source: "s" }),
      ).rejects.toThrow(/value/);
      await expect(
        writeMemoryFact(live, { scope: "user", key: "k", value: "v", source: "  " }),
      ).rejects.toThrow(/source/);
    });

    it("rejects empty tenantId/roleId/projectId/key on the read helpers", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(getAgentFact(live, { tenantId: "  ", roleId: "r" }, "k")).rejects.toThrow(
        /tenantId/,
      );
      await expect(getAgentFact(live, { tenantId: "t", roleId: "  " }, "k")).rejects.toThrow(
        /roleId/,
      );
      await expect(
        getProjectFact(live, { tenantId: "t", projectId: "  " }, "k"),
      ).rejects.toThrow(/projectId/);
      await expect(getUserFact(live, { tenantId: "t" }, "  ")).rejects.toThrow(/key/);
      await expect(readProfileTier(live, { tenantId: "  " })).rejects.toThrow(/tenantId/);
    });
  });
}
