# TASK-102 Dossier — apps/dashboard scaffold + run list/detail (E9.1a)

## Work Log

- [2026-09-02T13:40:00Z] [S5] Resumed session (branch task/TASK-102-s5 already existed, no dossier yet). Read AGENTS.md, briefings/S5_BUILD_BRIEFING.md, PLAN.md TASK-102 block, and control-api's `app.ts`/`auth.ts`/`ports.ts` (TASK-101) to understand the endpoints to wire against (`POST /auth/login`, `GET /runs`, `GET /runs/:id/evidence`, session cookie auth).

  Preflight (`python scripts/preflight_paths.py TASK-102`):
  ```
  [preflight] TASK-102 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 1 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   apps/dashboard/**  -> matches nothing yet (new territory)
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  `apps/dashboard/**` is genuinely empty — confirmed, this is a from-scratch scaffold.

  **Blocking discovery before writing any code:** the repo's pnpm workspace is registered via two
  explicit allow-lists, neither of which currently includes `apps/*`:
  - `pnpm-workspace.yaml` → `packages: ["packages/*", "services/*", "evals/*"]` (no `apps/*`)
  - `vitest.workspace.ts` → `["packages/*", "services/*"]` (no `apps/*`)

  Without an entry in `pnpm-workspace.yaml`, `pnpm install` will never recognize a new
  `apps/dashboard/package.json` as a workspace member at all — `pnpm --filter @oikonomos/dashboard build`
  would fail with "no matching projects", and root `pnpm -r build`/`pnpm -r test` would silently skip the
  new package rather than exercise it. `vitest.workspace.ts` has the same gap for `pnpm -r test`'s Vitest
  half specifically. TASK-102's own acceptance criteria require both:
  - "`pnpm --filter` build for the new package succeeds; if a test runner is set up, it's wired into `pnpm -r test`"
  - "`pnpm -r test`, `pnpm -r build`, `pnpm lint`, `pnpm canaries` all exit 0"

  These criteria are unsatisfiable without editing `pnpm-workspace.yaml` and `vitest.workspace.ts` — both
  root config files, both outside `Owned_Paths: apps/dashboard/**`. (`eslint.config.mjs`, by contrast, is
  glob-based over `**/*.{js,mjs,cjs,ts,mts,cts}` with no workspace allow-list, so `pnpm lint` will already
  reach `apps/dashboard` without any edit there — not a blocker.)

  Per AGENTS.md commandment 4 / briefing "Hard prohibitions": no edit outside Owned_Paths, ever, not even
  a one-line addition to a list. Setting status to `blocked` / `OWNERSHIP_CONFLICT` rather than reaching.
  No code written yet — nothing to commit on the branch this session; branch `task/TASK-102-s5` is
  unchanged from its pre-session state.

  **Exact paths needed, minimal scope:**
  - `pnpm-workspace.yaml` — add `"apps/*"` to the `packages:` list (single line)
  - `vitest.workspace.ts` — add `"apps/*"` to the array (single line)

  Either ORCH makes these two one-line additions directly (they're pack-infra/root-config, natural ORCH
  territory), or widens TASK-102's `Owned_Paths` to include them explicitly so a builder can. Once either
  happens, TASK-102 is otherwise fully scoped and ready — the control-api contract (auth cookie flow,
  `GET /runs`, `GET /runs/:id/evidence`) is already read and understood, no other ambiguity found.
