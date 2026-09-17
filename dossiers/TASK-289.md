# TASK-289 Dossier — `GET /roles/:roleId/template-status`

## Work Log

- [2026-09-17T15:40:00Z] [S5] Session start (control.mode=strict). Checkpoint file
  `.devteam/CHECKPOINT.md` found but referred to a *different*, already-merged task
  (TASK-248) from a prior session on this worktree — not relevant to TASK-289, left
  untouched per instructions (only delete once *this* task's context is resumed from
  it; it wasn't). Re-read PLAN.md fresh: TASK-289's `Review_Findings` is empty (no
  REWORK) and no prior dossier existed. Branch `task/TASK-289-s5` already existed
  (created by dispatcher) with zero diff vs `mainco/master` — fresh start, no code
  written yet.

- [2026-09-17T15:55:00Z] [S5] Investigated implementation path against
  `Owned_Paths` (`services/control-api/src/templates.ts`,
  `services/control-api/src/templates.test.ts` only). Read the existing
  `templates.ts` route file, `packages/db/src/templates.ts` (the `bot_templates`
  / `role_template_installs` accessor module), `services/control-api/src/ports.ts`
  (`ControlApiDeps`), and `packages/templates/src/digest.ts`.

  Findings:
  - The per-top-level-section digest comparison the spec requires (§6:
    `changed: [section...]` naming which sections drifted) is doable entirely
    inside my Owned_Paths: `packages/templates` only exports a *whole-manifest*
    `templateDigest`, but it does so via `canonicalJson` from `@oikonomos/shared`
    (a public export), so I can hash each top-level manifest key
    (`identity`, `skills`, `routines`, `integrations`, `memories`) myself inside
    `templates.ts` with `canonicalJson(section)` + `sha256`, without touching
    `packages/templates`. Not a blocker.
  - **Blocker:** there is no read accessor anywhere in the codebase for
    "the `role_template_installs` row for a given `roleId`". `packages/db/src/templates.ts`
    only has `createRoleTemplateInstall` (write, no return read path) — confirmed
    by reading the whole file and grepping the repo for
    `installed_from|role_template_install` (only hit is the INSERT statement
    itself). `ControlApiDeps` (`services/control-api/src/ports.ts`) has no
    corresponding `getRoleTemplateInstall` port either, and the module's own
    header comment states routes are barred from holding a `pg.Pool` or embedding
    SQL directly (`test/no-raw-sql.test.ts` enforces this as a liveness check) —
    so I cannot work around this with a raw query inside `templates.ts` even if
    my Owned_Paths permitted it (it doesn't touch `packages/db` or `ports.ts`
    either way).

    To implement `GET /roles/:roleId/template-status` for real (not a stub) I need,
    at minimum:
    1. `packages/db/src/templates.ts` — a new `getRoleTemplateInstall(options, roleId): Promise<RoleTemplateInstall | null>` accessor (plus its export from `packages/db/src/index.ts`).
    2. `services/control-api/src/ports.ts` — add `getRoleTemplateInstall?(roleId: string): Promise<RoleTemplateInstall | null>` to `ControlApiDeps`, wire it in `createDatabaseBackedDeps`, and import the new type/fn.

    Both are outside my `Owned_Paths` (`services/control-api/src/templates.ts`,
    `services/control-api/src/templates.test.ts`). Per AGENTS.md commandment 4 and
    the briefing's step 4 ("Need a file outside your territory? STOP → blocked,
    OWNERSHIP_CONFLICT, note what you need. Never edit outside your territory —
    not one line, not 'just an import'"), I am not touching either file.

    This also blocks the acceptance criterion "Real Postgres integration test
    covering all three cases" — `templates.test.ts`'s existing integration suite
    exercises the route through `createDatabaseBackedDeps` (real production
    composition), which needs the same new port to exist before a route wired to
    it can be tested end-to-end against real Postgres.

  Reported `blocked` / `OWNERSHIP_CONFLICT` this session rather than reaching
  into `packages/db` or `ports.ts`. No code changes made; branch still at zero
  diff vs `mainco/master`. Next builder/session picking this up: once
  `getRoleTemplateInstall` exists in `packages/db` and is exposed on
  `ControlApiDeps`, the route handler itself is straightforward — look up the
  install row (null → `{installed_from: null, drift: false, changed: []}`),
  else re-project the role via the already-built `projectRoleToManifest`
  (TASK-280, do not reimplement), fetch the installed template version via the
  existing `getBotTemplate` port, hash each top-level section of both manifests
  with `canonicalJson` + `sha256` (excluding `provenance`, same exclusion
  `templateDigest` already applies), and diff section-by-section.

- [2026-09-17T14:14:00Z] [S5] Resumed after ORCH widened Owned_Paths (`packages/db/src/templates.ts`,
  `packages/db/src/index.ts`, `services/control-api/src/ports.ts`) to include the
  `getRoleTemplateInstall` accessor the prior session correctly blocked on. Implemented:
  - `packages/db/src/templates.ts`: `getRoleTemplateInstall(options, roleId)` — reads
    `role_template_installs` by its primary key (`role_id`), returns `null` if absent.
    In-source validation + real-Postgres tests added (matches this file's existing
    convention: tests live inside `templates.ts` itself, not a sibling `.test.ts`,
    per TASK-276's own precedent noted in this file's header comment).
  - `packages/db/src/index.ts`: barrel-exported `getRoleTemplateInstall`.
  - `services/control-api/src/ports.ts`: added `getRoleTemplateInstall?(roleId)` to
    `ControlApiDeps` and wired it in `createDatabaseBackedDeps`.
  - `services/control-api/src/templates.ts`: added `GET /roles/:roleId/template-status`.
    Refactored the shared "re-project this role's current live state into a
    TemplateManifest" logic (previously inlined in the export route) into
    `projectCurrentManifest()`, reused by both the export route and the new status
    route so they build the "what does this role look like right now" half of any
    comparison identically. Section-by-section comparison uses a local recursive
    `sectionsEqual()` (order-independent for object keys, order-sensitive for
    arrays) rather than a canonical-JSON digest: `control-api`'s `package.json`
    does not depend on `@oikonomos/shared` (only `@oikonomos/db`/`@oikonomos/templates`/
    etc.), and adding that dependency is outside this task's `Owned_Paths`
    (`package.json` isn't listed). A structural equality check needs no such
    dependency and is exactly as correct for a yes/no "did this section change"
    signal — deliberately documented inline as a comment so a future reader
    doesn't "fix" it back to a digest compare and reintroduce the dependency.
    For the `memories` section, `projectCurrentManifest` is called with the key
    set already present in the *installed* manifest (not "every profile memory
    the role currently holds") — spec §6.1 re-projects the role and compares
    against the installed manifest; using the installed manifest's own key set
    keeps the comparison like-for-like instead of flagging every memory fact a
    role happens to hold today that was never part of the template.

  Real-Postgres integration test (`services/control-api/src/templates.test.ts`)
  initially found a genuine, real finding worth recording even though it isn't
  this task's to fix: a role created via the bare `createRole` DB call (not
  through `createRoleWithDefaultCapabilities`, the one path both `POST /roles`
  and template install itself use) has no default-floor grants, so exporting it
  and then installing it makes the *installed* role's `integrations` section
  differ from the export's (install always adds the floor; the artificially
  bare source never had it) — a false-positive "drift" purely from the test's
  own fixture setup, not real product behavior. Separately (and this one IS a
  real, product-level observation, not a test artifact): `createRoleWithDefaultCapabilities`
  (`services/control-api/src/templates.ts`, used by both `POST /roles` and
  `POST /templates/:id/install`) never carries `instructions`/`provider`/`model`
  onto the role it creates — so a template whose `identity.instructions` is
  non-null will show `drift: true` on `identity` immediately after install, before
  any human edits anything. That's TASK-278/281's route code, outside this task's
  Owned_Paths and Acceptance_Criteria (which only requires drift detection to be
  accurate against whatever the role's live state actually is — and it is
  accurate; the installed role's identity genuinely does differ). Fixed my own
  test to use a source role with no custom instructions (so it doesn't exercise
  that gap) and flagging it here for ORCH: `template-status` will show spurious
  `identity` drift on any real template that has non-null instructions, right
  after install, until TASK-278/281's install path is extended to carry identity
  fields onto the new role. Not blocking this task — the endpoint itself is
  spec-correct — but worth a follow-up task.

  Test evidence (isolated DB, `scripts/test-isolated.ps1`):
  - `@oikonomos/db`: 42 files / 248 passed / 2 skipped. (One transient,
    pre-existing, unrelated flake on the first run — `database.test.ts`'s
    "flips every registered capability platform-wide" — a parallel-worker race
    against the shared `oikonomos_test` capabilities table; reran alone and it
    passed clean, 42/42. Not touched by this task; `database.test.ts` isn't in
    Owned_Paths.)
  - `@oikonomos/control-api`: 24 files / 328 passed, including the new
    `template-status` unit tests (4) and the new real-Postgres integration test.
  - `pnpm --filter @oikonomos/db --filter @oikonomos/control-api typecheck`: clean
    (required `pnpm --filter @oikonomos/db build` first so control-api's `tsc`
    picked up the new `dist` export — `packages/db`'s `exports` field resolves to
    `dist`, not `src`).
  - Full recursive suite (`scripts/test-isolated.ps1`, no filter, per this
    project's amended review standard) launched in the background; result to be
    appended once it completes, before handing off to `needs_review`.
