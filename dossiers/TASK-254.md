# TASK-254 — dossier (S5)

## Task
`packages/db`'s TASK-119 role-grants test cleanup leaves an orphaned `capabilities`
row on an FK violation, poisoning every later suite in the same isolated-DB
script run.

## Work Log

- [2026-09-15T01:20:00Z] [S5] Session start. Checkpoint at `.devteam/CHECKPOINT.md`
  referenced TASK-227 (stale, from a prior session) — dispatch prompt for
  this session explicitly assigns TASK-254, control.mode=strict. Confirmed
  branch `task/TASK-254-s5` already exists (created by ORCH off
  `origin/master`, current HEAD `ea2d5aa`) and was already checked out,
  clean. No re-branching needed.

  Preflight (`python scripts/preflight_paths.py TASK-254`):
  ```
  [preflight] TASK-254 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 1 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/db/src/database.test.ts  -> exists, 229 line(s), 8687 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-15T01:22:00Z] [S5] Read `database.test.ts` in full. `cleanup()`
  for the TASK-119 suite (lines 89-95, pre-fix) deletes `role_grants` scoped
  to its own fixed `roleId`, then `roles`, then `capabilities` by ID — looked
  correct in isolation. Ruled out within-file Vitest concurrency (describe
  blocks in one file run sequentially, no `.concurrent` used) and
  cross-package concurrency (`scripts/test-isolated.ps1` enforces
  `--workspace-concurrency=1`) as the mechanism, since both review agents
  cited in the task description reproduced this against a "freshly-serialized"
  run.

- [2026-09-15T01:25:00Z] [S5] **Reproduced live, evidence-first, before writing
  any fix.** Ran `powershell -File scripts\test-isolated.ps1 -Filter "@oikonomos/db"`
  against the existing (non-`-Init`) isolated DB. Failed exactly as described:
  `error: update or delete on table "capabilities" violates foreign key
  constraint "role_grants_capability_id_fkey" on table "role_grants"`, thrown
  from `cleanup()`'s own `DELETE FROM capabilities` — and notably it failed
  on the **first** call to `cleanup()`, inside `beforeAll`, before this run's
  own suite had inserted anything. That ruled out anything internal to a
  single run of this suite.

- [2026-09-15T01:27:00Z] [S5] Queried the isolated DB directly (root-cause
  evidence, not assumption):
  `SELECT role_id, capability_id, max_tier FROM role_grants WHERE
  capability_id IN ('task-119.grants-suite.capability-a',
  'task-119.grants-suite.capability-b')` returned **112 rows**, every one
  under a random-UUID `role_id` — none matching this suite's own
  `task-119-grants-suite-role`. Spot-checked one UUID against `roles`:
  `98d00e7f-... | Persona c9f2dd14-... | basileia`.

  Traced `Persona ...` to `services/control-api/src/chat.routes.test.ts`
  (TASK-117/TASK-156 fixtures under `POST /roles — built-in grant database
  integration`): that suite's own first test asserts, by design, that
  `POST /roles` **auto-grants every enabled `sdk:builtin` capability** to
  whatever role it just created. `database.test.ts`'s TASK-119 fixture
  capabilities are inserted with `adapter: 'sdk:builtin', enabled: true`
  (lines 111-112). control-api's TASK-156 test creates a `Persona ...` role
  via the same route but **never deletes it afterward** (only `app.close()`
  in its `finally`). So: whenever a control-api `POST /roles` test runs
  while `database.test.ts`'s beforeAll has capabilityA/B present (both
  packages share one persistent `oikonomos_test` DB across separate
  `scripts/test-isolated.ps1` package runs, never reset except via `-Init`),
  the new Persona role permanently grants itself capabilityA/B, and that
  role/grant is never cleaned up — so it silently outlives the test run and
  blocks every subsequent `database.test.ts` run's `cleanup()`, which was
  scoped only to its own `roleId` and could never reach a grant held by an
  unrelated role.

  **This is a real, separate leak bug in `services/control-api/src/chat.routes.test.ts`
  (TASK-117/TASK-156 fixtures never delete the role they create) — flagged
  for ORCH below. Out of my Owned_Paths (`packages/db/src/database.test.ts`
  only), so not touched.**

- [2026-09-15T01:30:00Z] [S5] Applied the fix within Owned_Paths: both the
  TASK-119 and TASK-140 suites' `cleanup()` in `database.test.ts` now delete
  `role_grants` scoped by `capability_id` (in addition to the TASK-119
  suite's own `roleId`), not just by the suite's own role. This makes
  cleanup idempotent and order-safe regardless of which role — ours or a
  stray leaked one from another package's fixture — currently holds a grant
  on these two fixture capabilities, satisfying AC2's "either... or make the
  whole cleanup idempotent/order-safe regardless of what state a prior run
  left behind" path directly, and is safe/effective without needing to fix
  the control-api leak (though that remains a real bug worth its own task).
  Commit `45e0ce3`.

- [2026-09-15T01:35:00Z] [S5] Verified: `scripts/test-isolated.ps1 -Filter
  "@oikonomos/db"` run twice in a row, no `-Init` between them (same
  conditions as the failing baseline) — **both runs: 40/40 test files, 202
  passed | 2 skipped, exit code 0, zero `StaleCapabilityRowError`.** Directly
  queried the DB afterward: the 112 orphaned rows are gone (0 rows) — the
  fix self-heals the existing accumulated garbage, no manual DB
  intervention needed. Full recursive `pnpm -r test` via
  `scripts/test-isolated.ps1` (no filter) launched to complete AC4; result
  appended below/in the control block once it finishes.

- [2026-09-15T01:40:00Z] [S5] Full `pnpm -r test` (`scripts/test-isolated.ps1`,
  no filter) completed: **exit code 0, all packages green, 0
  StaleCapabilityRowError anywhere** (see Test_Evidence in control block for
  exact counts). Session complete — handing to `needs_review`.

## Flag for ORCH (not actioned — out of Owned_Paths)

`services/control-api/src/chat.routes.test.ts`'s `POST /roles — built-in
grant database integration (TASK-117)` describe block creates roles via
`POST /roles` in two `it` blocks ("persists every registered sdk:builtin
capability..." and "persists PATCHed role instructions... (TASK-156)") and
never deletes either role (or its capability grants) afterward — only
`app.close()`/`database.close()` run in `finally`. Since `POST /roles`
auto-grants every enabled `sdk:builtin` capability to the new role, and this
role/grant leak is permanent (not just this-run-scoped), every real
`sdk:builtin` capability that any test anywhere creates and later tries to
delete is at risk of hitting the exact same `role_grants_capability_id_fkey`
class of failure this task fixed defensively for `database.test.ts`
specifically. Worth a dedicated cleanup task (add `finally` blocks deleting
`role_grants`+`roles` for the created role IDs in both tests) — this
session's fix makes `database.test.ts` resilient to it, but does not stop
the leak itself from growing on every control-api test run.
