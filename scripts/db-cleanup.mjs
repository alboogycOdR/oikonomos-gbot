#!/usr/bin/env node
/**
 * TASK-231 — one-time (and repeatable) cleanup of test-fixture rows that
 * accumulate in the shared dev Postgres because `pnpm -r test` runs
 * against a live, non-isolated database rather than an ephemeral one.
 *
 * SELECTION RULE (the safety-critical part): a row is treated as a test
 * fixture ONLY if its `tenant_id` matches the literal shape
 * `task-<digits>-<uuid>` — the per-test isolation tenant convention this
 * repo's own test suites construct (see e.g.
 * `packages/db/src/roles.test.ts`, `services/worker/src/registerCapabilities.test.ts`).
 * A real user's tenant_id is either a Firebase UID (opaque, never shaped
 * like this) or the literal constant `"basileia"` used by real
 * production roles. This rule is DELIBERATELY conservative: it leaves the
 * `"basileia"`-tenant rows untouched even though some of those may also
 * be old test fixtures that didn't randomize their tenant, because there
 * is no safe way to distinguish those from real production data without
 * risking a false positive. Under-deleting is the acceptable failure mode
 * here, not over-deleting.
 *
 * Deletes in FK-dependency order (children before parents), scoped to the
 * matched tenant's roles/tasks/runs/threads, inside ONE transaction — a
 * partial failure rolls back everything rather than leaving the database
 * half-cleaned.
 *
 * Usage:
 *   node scripts/db-cleanup.mjs            # dry run (default) — reports counts, deletes nothing
 *   node scripts/db-cleanup.mjs --execute   # actually deletes, inside a transaction
 */
import pg from "pg";

const FIXTURE_TENANT_RE = /^task-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const execute = process.argv.includes("--execute");

const connectionString = process.env.DATABASE_URL;
if (!connectionString || connectionString.trim().length === 0) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

async function countAll() {
  const tables = [
    "roles", "tasks", "runs", "threads", "messages", "thread_members",
    "role_routines", "role_grants", "role_messages", "role_skills",
    "secret_values", "secret_requests", "require_approval_rules",
    "approvals", "intake_nonces",
  ];
  const counts = {};
  for (const t of tables) {
    const r = await client.query(`select count(*)::int as n from ${t}`);
    counts[t] = r.rows[0].n;
  }
  return counts;
}

try {
  // Materialize the target tenant set first, in JS, so the regex used for
  // the safety-critical selection rule is the exact one documented above
  // (re-verified against the live rows) rather than re-derived as a
  // separate, possibly-drifted SQL regex.
  const tenantsRes = await client.query("select distinct tenant_id from roles");
  const targetTenants = tenantsRes.rows
    .map((r) => r.tenant_id)
    .filter((t) => FIXTURE_TENANT_RE.test(t));

  console.log(`Fixture-shaped tenants found: ${targetTenants.length}`);
  if (targetTenants.length === 0) {
    console.log("Nothing to clean up.");
    await client.end();
    process.exit(0);
  }

  const before = await countAll();

  await client.query("BEGIN");

  // Target ID sets, scoped to the matched tenants.
  await client.query(`
    CREATE TEMP TABLE target_roles ON COMMIT DROP AS
      SELECT role_id FROM roles WHERE tenant_id = ANY($1::text[])
  `, [targetTenants]);
  await client.query(`
    CREATE TEMP TABLE target_tasks ON COMMIT DROP AS
      SELECT task_id FROM tasks WHERE tenant_id = ANY($1::text[])
  `, [targetTenants]);
  await client.query(`
    CREATE TEMP TABLE target_runs ON COMMIT DROP AS
      SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM target_tasks)
  `);
  await client.query(`
    CREATE TEMP TABLE target_threads ON COMMIT DROP AS
      SELECT id FROM threads WHERE role_id IN (SELECT role_id FROM target_roles)
  `);

  // Deletion order: children before parents (see FK graph in this task's
  // PLAN.md Progress_Notes for the full derivation).
  const steps = [
    ["intake_nonces", "DELETE FROM intake_nonces WHERE task_id IN (SELECT task_id FROM target_tasks)"],
    ["approvals", "DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM target_runs)"],
    ["secret_requests", "DELETE FROM secret_requests WHERE role_id IN (SELECT role_id FROM target_roles) OR run_id IN (SELECT run_id FROM target_runs)"],
    ["messages", "DELETE FROM messages WHERE run_id IN (SELECT run_id FROM target_runs) OR thread_id IN (SELECT id FROM target_threads) OR sender_role_id IN (SELECT role_id FROM target_roles)"],
    ["thread_members", "DELETE FROM thread_members WHERE role_id IN (SELECT role_id FROM target_roles) OR thread_id IN (SELECT id FROM target_threads)"],
    ["runs", "DELETE FROM runs WHERE run_id IN (SELECT run_id FROM target_runs)"],
    ["tasks", "DELETE FROM tasks WHERE task_id IN (SELECT task_id FROM target_tasks)"],
    ["role_routines", "DELETE FROM role_routines WHERE role_id IN (SELECT role_id FROM target_roles)"],
    ["threads", "DELETE FROM threads WHERE id IN (SELECT id FROM target_threads)"],
    ["require_approval_rules", "DELETE FROM require_approval_rules WHERE role_id IN (SELECT role_id FROM target_roles)"],
    ["role_grants", "DELETE FROM role_grants WHERE role_id IN (SELECT role_id FROM target_roles)"],
    ["role_messages", "DELETE FROM role_messages WHERE from_role_id IN (SELECT role_id FROM target_roles) OR to_role_id IN (SELECT role_id FROM target_roles)"],
    ["role_skills", "DELETE FROM role_skills WHERE role_id IN (SELECT role_id FROM target_roles)"],
    ["secret_values", "DELETE FROM secret_values WHERE role_id IN (SELECT role_id FROM target_roles)"],
    ["roles", "DELETE FROM roles WHERE role_id IN (SELECT role_id FROM target_roles)"],
  ];

  const deleted = {};
  for (const [name, sql] of steps) {
    const r = await client.query(sql);
    deleted[name] = r.rowCount;
  }

  if (execute) {
    await client.query("COMMIT");
    console.log("COMMITTED. Rows deleted per table:");
  } else {
    await client.query("ROLLBACK");
    console.log("DRY RUN (pass --execute to actually delete). Rows that WOULD be deleted per table:");
  }
  console.log(JSON.stringify(deleted, null, 2));

  if (execute) {
    const after = await countAll();
    console.log("Before -> after row counts:");
    for (const t of Object.keys(before)) {
      console.log(`  ${t}: ${before[t]} -> ${after[t]}`);
    }
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("FAILED, rolled back:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
