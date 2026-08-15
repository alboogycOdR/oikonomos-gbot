# TASK-011 — OIK-025 packages/audit append-only writer

**Brief:** The audit writer over the `audit_events` table. Every decision is written including denials, and a write failure must fail the action closed rather than being swallowed.

**Spec pointers:** WBS OIK-025. Synthesis §5.1 for the `audit_events` shape. ADR-001 R3 (fail closed). TASK-002 already enforces append-only in the database via `DO INSTEAD NOTHING` rules — verify the property from the writer's side rather than re-testing the SQL.

**Intended approach:** Typed writer over `@oikonomos/db`. Surface write failures to the caller explicitly. Integration tests against the compose Postgres following TASK-006's precedent of skipping cleanly when `DATABASE_URL` is unset. N4 is sharp here: audit payloads are exactly where a careless fixture leaks a credential.

## Work Log

- [2026-08-15T13:30:00Z] [S5] Session start (control.mode=strict, task pre-claimed by dispatcher). Worktree was detached HEAD at `8bf3cd0`; created `task/TASK-011-s5` there, then fast-forwarded it to `master`@`4b0efd9` (`chore(plan): dispatch wave 2 — S5→TASK-011, CX→TASK-013 [ORCH]`) — no code commits existed yet on the branch, so the fast-forward carried nothing but PLAN.md's already-merged history, no ownership conflict.

  Preflight (`python scripts/preflight_paths.py TASK-011`):
  ```
  [preflight] TASK-011 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-s5-oikonomos
  [preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   packages/audit/src/**  -> 1 file(s):
             packages/audit/src/index.ts
    GLOB   packages/audit/test/**  -> matches nothing yet (new territory)
    FILE   packages/audit/vitest.config.ts  -> exists, 8 line(s), 166 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

  **Blocked before writing code — OWNERSHIP_CONFLICT, same class as TASK-006's precedent (see dossiers/TASK-006.md work log).** The dossier's own "Intended approach" says "Typed writer over `@oikonomos/db`" — read `packages/db/src/database.ts` in full: the exported `Database` class has exactly seven methods (`close`, `getCapability`, `listCapabilities`, `upsertCapability`, `getRoleGrant`, `listRoleGrants`, `upsertRoleGrant`), all scoped to `capabilities`/`role_grants`. Nothing touches `audit_events`, and there is no generic `query()`/pool escape hatch — by design (`packages/policy` has zero I/O, and `harness-factory` is the only sanctioned raw-query path per CLAUDE.md's non-negotiable #3). So an append-only `audit_events` writer cannot be built "over `@oikonomos/db`" without `@oikonomos/db` growing an audit-write method — and `packages/db/src/**` is not in this task's `Owned_Paths`.

  The alternative — give `packages/audit` its own `pg` client directly — is explicitly foreclosed by TASK-009 (already merged, `bd97f62`): its Progress_Notes/Description state verbatim "Add NO external runtime dependency — nothing in this wave needs one (pg already lives in packages/db...)" and its `Owned_Paths` (which included `packages/audit/package.json`) intentionally did not add `pg` there. Confirmed on disk: `packages/audit/node_modules` has no `pg` (only `@types`, `typescript`, `vitest`), vs. `packages/db/node_modules/pg` which exists; `packages/audit/package.json` dependencies are only `@oikonomos/db` + `@oikonomos/shared`. Under this repo's strict pnpm linking (no `shamefully-hoist`/`public-hoist-pattern` in `.npmrc`, confirmed: root `node_modules/pg` doesn't exist, only `node_modules/.pnpm/pg@8.23.0`), `import "pg"` from `packages/audit/src/**` or `packages/audit/test/**` would fail to resolve at runtime even if I wrote it — this isn't a style preference, it's inoperable as scoped.

  Net: TASK-011 cannot be completed within `packages/audit/src/**`, `packages/audit/test/**`, `packages/audit/vitest.config.ts` alone. It needs one of:
  1. `packages/db/src/**` gains a narrow, generic-enough method (e.g. `insertAuditEvent(event): Promise<{eventId: bigint}>`, or a minimal `query<T>(text, params)` escape hatch scoped to this use) that `packages/audit` can call — Owned_Paths would need to add `packages/db/src/**` (or a single named file within it) to this task, or a companion integration task per protocol §4 (same shape as TASK-009), or
  2. `packages/audit/package.json` (+ `pnpm-lock.yaml`) is granted `pg` as a direct dependency, reversing TASK-009's deliberate decision — which only ORCH can weigh, since it contradicts a just-merged, reviewed decision.

  Did not write any implementation code against a guessed API — no `Database` method exists to target, and guessing one risks exactly the kind of drift TASK-009 was created to prevent. Stopping here per AGENTS.md commandment 10 ("When in doubt, block — don't improvise") and the briefing's "reaching is always worse than blocking."

- [2026-08-15T15:50:00Z] [S5] Session start (control.mode=strict, resumed). No `task/TASK-011-s5` git branch existed anywhere in the repo (checked all four worktrees + `git for-each-ref` + `packed-refs`) — the branch created last session was apparently never persisted as a ref, only the dossier commit `d86c4ba` survived (reachable as a loose object). Recreated the branch: `git checkout -b task/TASK-011-s5` from the worktree's then-HEAD, `git cherry-pick d86c4ba --no-commit` to restore the blocked-analysis work-log entry, committed as `892f3b5` → `9f657c0` after rebase. Also found the worktree's checked-out `PLAN.md` was 4 commits stale (`Status: pending` instead of the main checkout's `claimed`) — `git rebase master` (local, same object store, no remote) brought it current; territory-firewall correctly refused writes until this was done (`no active claimed/in_progress task`), which is exactly the fail-closed behaviour working as intended, not a bug to route around.

  TASK-020 (blocking dependency) is now `done` and merged — `@oikonomos/db` exports `insertAuditEvent(options, event): Promise<AuditEvent>` (write errors propagate, never swallowed) from `packages/db/src/auditEvents.ts`. Read it in full plus `packages/db/src/index.ts`, `database.ts`, `types.ts`, and TASK-020's own `persistence-surface.test.ts` precedent (structural "does not export a mutating operation" test) before writing any code.

  Implemented `packages/audit/src/index.ts`:
  - `recordAuditEvent(options, event)` — thin wrapper over `insertAuditEvent`; catches and re-throws as `AuditWriteError` (carries `actor`, `eventType`, `cause`) so a caller can tell "audited" from "not audited" (ADR-001 R3) — never swallows, always rejects.
  - `recordDecision` / `toDecisionAuditEvent` — maps a policy/broker verdict (`allow` | `require_approval` | `deny`, per Synthesis Spec §5.2 `PolicyDecision`) to a `policy.decision` audit event; `reason` folds into `payload`. `toDecisionAuditEvent` is a pure function exported separately so the mapping is unit-testable without a database (4 in-source tests, no I/O).
  - No update/delete/mutate export exists anywhere in the module — verified structurally in `test/persistence-surface.test.ts` (mirrors TASK-020's own `approvalsApi` structural test almost exactly), which is how AC3 ("UPDATE and DELETE ... provable no-ops when exercised through this package") is satisfied: there is no exported function through which one could even be attempted, on top of the DB's own `DO INSTEAD NOTHING` rules from TASK-002 (which the task description explicitly says not to re-test).

  **`pg` is not reachable from `packages/audit/test/**` under this repo's strict pnpm linking** (`packages/audit/package.json` — out of `Owned_Paths` — declares only `@oikonomos/db` and `@oikonomos/shared`; confirmed via `pnpm-lock.yaml`'s `packages/audit:` block). So unlike `packages/db`'s own integration tests, this package's tests cannot open a second raw connection to independently re-query rows after insert. Proof of persistence instead rests on the `RETURNING` row Postgres itself hands back through `insertAuditEvent` (a real generated `event_id`, not a mock) — the same standard TASK-020's own review already accepted.

  Test evidence (own ephemeral container, not the shared compose volume — same isolation TASK-020 used):
  ```
  docker run -d --name oikonomos-audit-test-pg -p 127.0.0.1:55433:5432 \
    -e POSTGRES_DB=oikonomos -e POSTGRES_USER=oikonomos -e POSTGRES_PASSWORD=local_test_only \
    pgvector/pgvector:pg16
  docker exec -i oikonomos-audit-test-pg psql -U oikonomos -d oikonomos < infra/postgres/migrations/001_schema_v1.up.sql
  cd packages/audit
  DATABASE_URL=postgresql://oikonomos:local_test_only@127.0.0.1:55433/oikonomos pnpm test
    → 3 files, 14/14 tests pass (denial produces a row w/ distinct event_id from the allow written
      alongside it; require_approval written the same way; generic tool.request event type; induced
      uuid write failure rejects as AuditWriteError with actor/eventType/cause populated; empty
      connectionString rejects as AuditWriteError before opening a pool)
  pnpm test   # no DATABASE_URL
    → 3 files, 9 passed / 5 skipped (integration suite skips cleanly, unit + structural tests still run)
  docker rm -f oikonomos-audit-test-pg   # own container torn down, shared compose volume untouched
  ```
  Also: `pnpm --filter @oikonomos/audit typecheck` clean; `pnpm -r typecheck` clean (all 14 buildable packages/services); `pnpm lint` (root, eslint over whole repo) clean; `node infra/ci/secret-scan.mjs` → `secret-scan: clean`.

  All 5 acceptance criteria met. Committed to `task/TASK-011-s5` as `9b5868e` (`feat(audit): append-only writer over @oikonomos/db insertAuditEvent [TASK-011]`) on top of the restored dossier commit. Handing off `needs_review`.