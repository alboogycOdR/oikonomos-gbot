# TASK-084 — packages/db + migration 004 — role identity, routines, messages, require-approval rules (D0 schema)

**Assigned_To:** S5 · **Depends_On:** —

## Brief

Turn `role_id` from free text into a real D0 identity. Migration 004 creates `roles`, `role_routines`, `role_messages` and `require_approval_rules`, wires FKs from the existing `role_grants.role_id` and `tasks.routine_id`, and ships a typed query layer. Everything else in the ADR-010 wave depends on these rows existing.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §3.1 (F4 roles table), §3.4 (F7 role_routines), §3.5 (F8 role_messages), §5.4 (F15 require_approval_rules), §9 OIK-200; docs/decisions/ADR-010 §2.2

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`infra/postgres/migrations/004_roles_routines_rules.up.sql, infra/postgres/migrations/004_roles_routines_rules.down.sql, packages/db/src/roles.ts, packages/db/src/roles.test.ts, packages/db/src/routines.ts, packages/db/src/routines.test.ts, packages/db/src/roleMessages.ts, packages/db/src/roleMessages.test.ts, packages/db/src/requireApprovalRules.ts, packages/db/src/requireApprovalRules.test.ts, packages/db/src/index.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

Read Addendum F §3.1, §3.4, §3.5 and §5.4 for the exact column lists — they are specified, not left to judgment. Start with the migration and its down-reverse test, then one query module per table. The backfill guard is the part most likely to bite: real rows already reference role_ids with no row behind them, and a migration that errors on them is a migration that cannot run. N12 lands here first — `roles.description` is prompt material, never an authorization input.

## Work Log

- [2026-09-01T21:56:00Z] [S5] Preflight (python scripts/preflight_paths.py TASK-084), run after branching task/TASK-084-s5 from origin/master (rebased to pick up the claim commit — first branch attempt was cut from a stale point before the claim landed):
  ```
  [preflight] TASK-084 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 11 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    infra/postgres/migrations/004_roles_routines_rules.up.sql  -> does not exist; parent infra/postgres/migrations/ exists
    NEW    infra/postgres/migrations/004_roles_routines_rules.down.sql  -> does not exist; parent infra/postgres/migrations/ exists
    NEW    packages/db/src/roles.ts  -> does not exist; parent packages/db/src/ exists
    NEW    packages/db/src/roles.test.ts  -> does not exist; parent packages/db/src/ exists
    NEW    packages/db/src/routines.ts  -> does not exist; parent packages/db/src/ exists
    NEW    packages/db/src/routines.test.ts  -> does not exist; parent packages/db/src/ exists
    NEW    packages/db/src/roleMessages.ts  -> does not exist; parent packages/db/src/ exists
    NEW    packages/db/src/roleMessages.test.ts  -> does not exist; parent packages/db/src/ exists
    NEW    packages/db/src/requireApprovalRules.ts  -> does not exist; parent packages/db/src/ exists
    NEW    packages/db/src/requireApprovalRules.test.ts  -> does not exist; parent packages/db/src/ exists
    FILE   packages/db/src/index.ts  -> exists, 64 line(s), 1385 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  All target paths matched exactly what the task expected (9 NEW, index.ts existing for barrel-export addition). No ownership conflict.

- [2026-09-01T22:15:00Z] [S5] Implemented migration 004 (up/down) per Addendum F §3.1/§3.4/§3.5/§5.4: roles, role_routines, role_messages, require_approval_rules, with FKs added to the pre-existing `role_grants.role_id` and `tasks.routine_id` columns. Added a backfill guard (two-part INSERT ... SELECT ... WHERE NOT EXISTS, ON CONFLICT DO NOTHING) so pre-existing orphaned role_ids/routine_ids get a placeholder `roles`/`role_routines` row instead of failing the ALTER TABLE ADD CONSTRAINT. One extra column beyond the spec's literal list, `role_routines.last_fire_status text CHECK (IN ('queued','missed'))`, added deliberately to satisfy this task's own acceptance criterion "a missed fire recorded distinctly from a queued one" (§3.4) — documented inline in the migration; all Addendum F-specified columns and defaults are present and unchanged.

  Applied up.sql directly against the local dev Postgres (`oikonomos-postgres-local`, DATABASE_URL from the environment) to prove it runs against real data: `INSERT 0 1` on the roles backfill confirmed the pre-existing `inbox-triage` role_grants row (no roles row behind it) got backfilled correctly (status active, description empty, verified via `SELECT * FROM roles`). Ran up → down → up: down.sql dropped exactly the 4 new tables + 2 FKs (`\dt` after down showed the original 9 tables, unchanged), re-up reproduced the identical schema (same INSERT 0 1 backfill, same tables/indexes/constraints).

  Verified migrations 001–003 byte-identical to origin/master (`git diff origin/master -- infra/postgres/migrations/00{1,2,3}_*.sql` — empty diff) and that `profile_facts`/`risk_tier` enum are untouched by 004 (004 never references them).

  Built the typed query layer: roles.ts (createRole/getRole/listRoles, roleStatuses), routines.ts (createRoutine/getRoutine/listRoutines/recordRoutineFire — the last implementing the missed-vs-queued bookkeeping: `queued` bumps last_fire_at, `missed` only sets last_fire_status, leaving last_fire_at untouched so a miss is never mistaken for a fire), roleMessages.ts (sendRoleMessage/getRoleMessage/listRoleMessages/markRoleMessageRead per F8's async/no-privilege/no-file-bytes shape), requireApprovalRules.ts (createRequireApprovalRule/getRequireApprovalRule/listRequireApprovalRules with roleId:null meaning whole-tenant per F15). Every list function requires tenantId (not optional) — no "all tenants" escape hatch anywhere in this task's territory. Followed the existing house style exactly (tasks.ts/runs.ts pattern): each module owns its own local `withPool`/`requireNonEmpty`/`requireUuid` helpers rather than sharing them, matching the convention already established across the package.

  N12 (roles.description is advisory only, never an authorization input): added a source-scan liveness test in roles.test.ts that reads the raw source of all four new modules and fails if `description` appears in any conditional/comparison/boolean-expression context, distinct from an interface declaration or straight passthrough mapping. Hardened the regex/token allowlist through three iterations to avoid false positives on `description?: string` (optional prop), `input.description ?? ""` (nullish coalescing), and multi-line SQL template literals containing the column name — confirmed it still correctly rejects `description ===`, `.includes(`, `if (description`, `&&`/`||` combinations, and a space-delimited ternary.

  Barrel-exported everything from packages/db/src/index.ts (sole owner this wave per the task description).

- [2026-09-01T22:35:00Z] [S5] Full test evidence, all commands run from repo root with DATABASE_URL pointed at the local dev Postgres (oikonomos-postgres-local, already running):
  - `pnpm --filter @oikonomos/db build` — exit 0 (tsc clean)
  - `pnpm --filter @oikonomos/db typecheck` — exit 0 (tsc --noEmit clean)
  - `pnpm --filter @oikonomos/db test` (DATABASE_URL set) — 22 test files, 107 tests, 0 failed. Includes: roles.test.ts (9, incl. F4 FK rejection + backfill-guard fixture + N12 source-scan), routines.test.ts (6, incl. F7 FK rejection + missed-vs-queued bookkeeping distinctness), roleMessages.test.ts (6, incl. F8 dual FK rejection + inbox/unreadOnly), requireApprovalRules.test.ts (7, incl. F15 dual FK rejection + roleId:null tenant-wide filter + enabledOnly), plus all pre-existing suites still green (tasks/runs/approvals/auditEvents/intakeNonces/capabilities unaffected).
  - `pnpm lint` (root) — exit 0, zero findings.
  - `pnpm -r build` (root, 16 workspaces) — exit 0, all packages/services compile including downstream consumers of packages/db (broker, policy, approvals, worker, control-api, etc.) — confirms the index.ts barrel-export change breaks nothing.
  - `pnpm -r test` (root, DATABASE_URL set) — every workspace green: packages/db, approvals (119 tests), connectors (101+4 skipped), harness-factory (85), broker (84), audit, control-api (59), gateway-telegram (68), worker (24+1 skipped), evals/golden (6), evals/harness (17) — zero failures anywhere in the recursive suite (per CLAUDE.md's amendment: full `pnpm -r test`, not task-scoped).
  - `pnpm canaries` — CAN-01..CAN-09, 17/17 passed, exit 0.
  All acceptance criteria verified: migration up/down/up idempotent+identical (manual DB run, documented above); FK rejection tested for role_grants.role_id, tasks.routine_id, role_messages.from/to_role_id, require_approval_rules.role_id/capability_id; backfill guard tested against a constructed orphan fixture; typed CRUD+list with tenant_id scoping on every read; missed-vs-queued fire bookkeeping tested distinctly; migrations 001-003/profile_facts/risk_tier byte-identical (diff empty, documented above); N12 liveness assertion in place and passing; pnpm -r test / lint / canaries all exit 0.

  Status: needs_review. Branch task/TASK-084-s5 @ 6ec59c0 (single commit, all 11 owned files). No PLAN.md edits made (control.mode=strict).
