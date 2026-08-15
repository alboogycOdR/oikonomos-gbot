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