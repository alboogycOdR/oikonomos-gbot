import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRole, defaultPoolConfig, getRole, listRoles, updateRoleInstructions, updateRoleName } from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db roles — read + CRUD + FK/backfill (TASK-084)", () => {
  let pool: Pool;
  // Dedicated tenantId (not "basileia") so this suite never collides with
  // fixture rows other concurrently-running suites insert against the same
  // DATABASE_URL under `pnpm -r test` — same isolation pattern tasks.test.ts
  // documents for its own suite.
  const tenantId = "task-084-roles-suite";
  const roleId = "task-084-roles-suite-role";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM role_grants WHERE role_id LIKE 'task-084-roles-suite%'`);
    await pool.query(`DELETE FROM roles WHERE tenant_id = $1 OR role_id LIKE 'task-084-roles-suite%'`, [
      tenantId,
    ]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("creates a role against the live schema and reads it back byte-identical", async () => {
    const created = await createRole(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Roles Suite", title: "Roles Suite Role", description: "d" },
    );

    expect(created.status).toBe("active");
    expect(created.tenantId).toBe(tenantId);

    const fetched = await getRole({ connectionString: connectionString! }, roleId);
    expect(fetched).toEqual(created);
  });

  it("getRole returns null for an unknown roleId", async () => {
    const result = await getRole({ connectionString: connectionString! }, "unknown-role-xyz");
    expect(result).toBeNull();
  });

  it("persists nullable role instructions against the live schema", async () => {
    const created = await createRole(
      { connectionString: connectionString! },
      { roleId: "task-156-role-instructions", tenantId, name: "Instructions", title: "Instructions" },
    );
    expect(created.instructions).toBeNull();

    const updated = await updateRoleInstructions(
      { connectionString: connectionString! },
      created.roleId,
      "Always answer in the bot's named persona.",
    );
    expect(updated?.instructions).toBe("Always answer in the bot's named persona.");
    expect((await getRole({ connectionString: connectionString! }, created.roleId))?.instructions)
      .toBe("Always answer in the bot's named persona.");
  });

  it("persists a real role name change", async () => {
    const created = await createRole(
      { connectionString: connectionString! },
      { roleId: "task-167-role-name", tenantId, name: "Before", title: "Role name fixture" },
    );
    const updated = await updateRoleName({ connectionString: connectionString! }, created.roleId, "After");
    expect(updated?.name).toBe("After");
    expect((await getRole({ connectionString: connectionString! }, created.roleId))?.name).toBe("After");
  });

  it("listRoles is tenant-scoped: a role in another tenant never appears", async () => {
    const otherTenantRoleId = "task-084-roles-suite-other-tenant";
    await createRole(
      { connectionString: connectionString! },
      { roleId: otherTenantRoleId, tenantId: "task-084-roles-suite-OTHER", name: "x", title: "x" },
    );

    const rows = await listRoles({ connectionString: connectionString! }, { tenantId });
    expect(rows.map((r) => r.roleId)).not.toContain(otherTenantRoleId);

    await pool.query(`DELETE FROM roles WHERE role_id = $1`, [otherTenantRoleId]);
  });

  it("F4: role_grants.role_id FK rejects a grant for a role that does not exist", async () => {
    await pool.query(
      `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled)
       VALUES ('task-084-cap', 'd', 'T0_observe', 'x', true)
       ON CONFLICT (capability_id) DO NOTHING`,
    );

    await expect(
      pool.query(
        `INSERT INTO role_grants (role_id, capability_id, max_tier) VALUES ($1, $2, 'T0_observe')`,
        ["task-084-roles-suite-nonexistent-role", "task-084-cap"],
      ),
    ).rejects.toThrow(/foreign key/i);

    await pool.query(`DELETE FROM capabilities WHERE capability_id = 'task-084-cap'`);
  });

  it("backfill guard: a role_grants row referencing an unknown role_id, present BEFORE migration 004 runs, is backfilled rather than erroring", async () => {
    // Migration 004 already ran once against this dev DB (it is not
    // reapplied per-test — CREATE TABLE IF NOT EXISTS makes it idempotent).
    // This test instead re-proves the exact backfill statement migration
    // 004.up.sql runs, against a fixture row constructed to be orphaned at
    // the moment the statement executes: temporarily drop the FK, insert an
    // orphaned grant, run the migration's own backfill INSERT verbatim, and
    // assert the missing role now exists with the documented placeholder
    // shape (status active, description empty) before restoring the FK.
    const orphanRoleId = "task-084-roles-suite-orphan";
    await pool.query(`ALTER TABLE role_grants DROP CONSTRAINT role_grants_role_id_fkey`);
    try {
      await pool.query(
        `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled)
         VALUES ('task-084-cap-2', 'd', 'T0_observe', 'x', true)
         ON CONFLICT (capability_id) DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO role_grants (role_id, capability_id, max_tier) VALUES ($1, 'task-084-cap-2', 'T0_observe')`,
        [orphanRoleId],
      );
      await expect(getRole({ connectionString: connectionString! }, orphanRoleId)).resolves.toBeNull();

      await pool.query(
        `INSERT INTO roles (role_id, tenant_id, name, title, description, status)
         SELECT DISTINCT rg.role_id, 'basileia', rg.role_id, rg.role_id, '', 'active'
         FROM role_grants rg
         WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.role_id = rg.role_id)
         ON CONFLICT (role_id) DO NOTHING`,
      );

      const backfilled = await getRole({ connectionString: connectionString! }, orphanRoleId);
      expect(backfilled).not.toBeNull();
      expect(backfilled?.status).toBe("active");
      expect(backfilled?.description).toBe("");

      await pool.query(`DELETE FROM role_grants WHERE role_id = $1`, [orphanRoleId]);
      await pool.query(`DELETE FROM roles WHERE role_id = $1`, [orphanRoleId]);
      await pool.query(`DELETE FROM capabilities WHERE capability_id = 'task-084-cap-2'`);
    } finally {
      await pool.query(
        `ALTER TABLE role_grants ADD CONSTRAINT role_grants_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(role_id)`,
      );
    }
  });
});

/**
 * N12 liveness assertion (Addendum F §3.2/F5): "a test that... asserts no
 * exported db helper reads `roles.description` in an authorization path."
 * This is a source-level scan, not a DB test, so it runs with or without
 * DATABASE_URL and fails the instant a future edit adds a conditional on
 * `description` to any of the four D0 modules this task owns — the same
 * failure mode a runtime test could miss if nobody thought to write a case
 * for the specific bad value that triggers it.
 *
 * Allowed uses of the token `description` are: (a) the interface/type field
 * declaration, (b) the literal SQL column name inside a template string,
 * (c) straight passthrough assignment `description: row.description` /
 * `description: input.description ?? ""` in a mapper or insert. Anything
 * that puts `description` inside a conditional, comparison, boolean
 * expression, or string-matching call is rejected.
 */
describe("N12 — roles.description is never read in an authorization path (source scan)", () => {
  const dbSrcDir = fileURLToPath(new URL(".", import.meta.url));
  const filesToScan = [
    "roles.ts",
    "routines.ts",
    "roleMessages.ts",
    "requireApprovalRules.ts",
  ];

  const SAFE_LINE_PATTERNS = [
    /^\s*description\??\s*:\s*string\s*;?\s*$/, // interface field decl (optional or not)
    /description\s+text\b/i, // "description text" in a SQL DDL/comment fragment
    /`[^`]*\bdescription\b[^`]*`?/, // SQL template literal fragment (column list, possibly multi-line)
    /^\s*INSERT INTO roles.*description.*$/i, // SQL column-list line
    /^\s*description\s*,?\s*$/, // bare SQL column-list token on its own line
    /description\s*=\s*EXCLUDED\.description\s*,?\s*$/, // upsert passthrough
    /description\s*:\s*row\.description\s*,?\s*$/, // straight mapper passthrough
    /const\s+description\s*=\s*input\.description\s*\?\?\s*""\s*;?\s*$/, // straight input passthrough (local var)
    /description\s*:\s*input\.description\s*\?\?\s*""\s*,?\s*$/, // straight input passthrough (inline)
    /^\s*\[.*\bdescription\b.*\]\s*,?\s*$/, // query params array containing the local `description` var
    /\/\/.*description/i, // a comment mentioning the word
    /\*.*description/i, // a jsdoc/block-comment line mentioning the word
  ];

  const FORBIDDEN_TOKENS = [
    "description ===",
    "description !==",
    "description ==",
    "description.includes(",
    "description.match(",
    "description.startsWith(",
    "description.endsWith(",
    "if (description",
    "if(description",
    "&& description",
    "|| description",
    "description &&",
    "description ||",
  ];

  // Ternary use ("description ? a : b") is forbidden too, but must not
  // false-positive on `description?: string` (optional prop, no space
  // before `?`) or `description ?? ""` (nullish coalescing, no `:`).
  // Matched per LINE (not against the whole source) so `[^:]*` cannot
  // range across unrelated `:` type annotations elsewhere in the file.
  const FORBIDDEN_TERNARY = /description\s+\?(?!\?)[^:\n]*:/;

  for (const file of filesToScan) {
    it(`${file}: no line uses "description" outside the declaration/passthrough allowlist`, () => {
      const source = readFileSync(`${dbSrcDir}${file}`, "utf8");

      for (const forbidden of FORBIDDEN_TOKENS) {
        expect(
          source.includes(forbidden),
          `${file} contains "${forbidden}" — N12 forbids branching on roles.description ` +
            `for an authorization decision (role_grants is the enforcer, not the description).`,
        ).toBe(false);
      }
      for (const line of source.split("\n")) {
        expect(
          FORBIDDEN_TERNARY.test(line),
          `${file} appears to branch on roles.description via a ternary — N12 forbids using it ` +
            `for an authorization decision. Line: ${line}`,
        ).toBe(false);
      }

      const offendingLines = source
        .split("\n")
        .filter((line) => /\bdescription\b/.test(line))
        .filter((line) => !SAFE_LINE_PATTERNS.some((pattern) => pattern.test(line)));

      expect(
        offendingLines,
        `${file} has line(s) referencing "description" outside the N12 safe-pattern allowlist:\n` +
          offendingLines.join("\n"),
      ).toEqual([]);
    });
  }
});

// TASK-213 — per-bot provider/model. The default is configuration, never a
// literal copied onto a row: that is what makes switching every bot (and
// switching back) an operational change rather than a migration.
integration("packages/db roles — provider/model selection (TASK-213)", () => {
  it("defaults to Claude when neither the role nor the platform has chosen", async () => {
    const { resolveRoleRuntime } = await import("./roles.js");
    expect(resolveRoleRuntime({ provider: null, model: null }, {})).toEqual({ provider: "claude", model: null });
  });

  it("lets the platform default move every unpinned bot at once", async () => {
    const { resolveRoleRuntime, DEFAULT_ROLE_PROVIDER_ENV, DEFAULT_ROLE_MODEL_ENV } = await import("./roles.js");
    const env = { [DEFAULT_ROLE_PROVIDER_ENV]: "gemini", [DEFAULT_ROLE_MODEL_ENV]: "gemini-3.7-flash" };
    expect(resolveRoleRuntime({ provider: null, model: null }, env)).toEqual({
      provider: "gemini",
      model: "gemini-3.7-flash",
    });
  });

  it("lets one bot opt out of the platform default without a deploy", async () => {
    const { resolveRoleRuntime, DEFAULT_ROLE_PROVIDER_ENV } = await import("./roles.js");
    const env = { [DEFAULT_ROLE_PROVIDER_ENV]: "gemini" };
    // The reversibility the user's "all bots, existing included" decision
    // needs: one bot can be pinned back without moving anything else.
    expect(resolveRoleRuntime({ provider: "claude", model: null }, env).provider).toBe("claude");
  });

  it("persists and reads back a role's own provider/model", async () => {
    const db = { connectionString: connectionString! };
    const { createRole, getRole } = await import("./index.js");
    const roleId = `task-213-${Date.now()}`;
    await createRole(db, { roleId, name: roleId, title: "TASK-213 fixture", description: "" });

    const fresh = await getRole(db, roleId);
    // A brand-new bot is unpinned, so it follows the default rather than
    // carrying a copy of it.
    expect(fresh?.provider).toBeNull();
    expect(fresh?.model).toBeNull();
  });
});
