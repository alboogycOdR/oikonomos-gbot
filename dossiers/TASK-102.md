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

- [2026-09-02T14:10:00Z] [S5] Resumed on redispatch. PLAN.md TASK-102 Progress_Notes confirm ORCH resolved
  the blocker directly (commit `9264afc`, `chore(workspace): register apps/* in pnpm-workspace.yaml +
  vitest.workspace.ts [TASK-102] [ORCH]`) — verified both files on disk in this worktree already contain
  `apps/*`. Proceeded to implement.

  Read `services/control-api/src/app.ts`, `auth.ts`, `ports.ts` in full for the exact contract: session
  auth is an httpOnly signed cookie (`control_api_session`) issued by `POST /auth/login` on a valid shared
  `CONTROL_API_TOKEN`; every other route requires either that cookie or a `Bearer` header. `GET /runs`
  returns `{ runs: Run[], nextCursor: string | null }` (keyset pagination via opaque cursor). `Run` has no
  `role` field (only `Task.roleId` does, and `/runs` never joins it) — this task's AC literally says
  "status/role/timestamps" but the real endpoint has no role to show without a new control-api endpoint
  (out of scope). Documented the substitution (show `taskId` instead) inline in `RunListPage.tsx` and here,
  rather than silently dropping the requirement or reaching into control-api's Owned_Paths to add a join.

  Scaffolded `apps/dashboard` as a Vite + React 19 + TypeScript SPA (react-router-dom for routing), NOT
  Next.js/SSR, matching the task Description's explicit call. Structure:
  - `src/lib/api.ts` — thin fetch wrapper, `credentials: "same-origin"` so the httpOnly session cookie
    rides along automatically; every call surfaces a 401 as `UnauthorizedError` for uniform route-guard
    handling. No token/cookie ever touches localStorage/sessionStorage or app state.
  - `src/lib/AuthContext.tsx` — in-memory-only `isAuthenticated` flag (deliberately NOT persisted across
    reload — the real trust boundary is control-api's cookie; a stale client-side "remembered" flag with no
    valid server-side session would show protected UI that then 401s on first fetch, which is worse).
  - `src/components/RequireAuth.tsx` — redirects to `/login` on any protected route when unauthenticated
    (AC #1).
  - `src/pages/LoginPage.tsx` — posts token to `/auth/login`, navigates to the originally-requested route
    (or `/runs`) on success.
  - `src/pages/RunListPage.tsx` — `GET /runs`, table of runId/taskId/status/started/ended, Previous/Next
    paginated via a cursor stack built from the real `nextCursor` (AC #2).
  - `src/pages/RunDetailPage.tsx` — `GET /runs/:id` + `GET /runs/:id/evidence` in parallel, renders run
    metadata and the full audit-event table (AC #3).
  - No hardcoded/mock data anywhere — every data-bearing view calls the real control-api client (AC #4).

  **Static hosting choice (task Description explicitly leaves this to the builder, "state the choice and
  why"):** documented here as "serve `apps/dashboard/dist` from a separate static host", NOT a
  `@fastify/static` mount inside `services/control-api` — that file is outside this task's
  `Owned_Paths: apps/dashboard/**`, and wiring it in directly would be exactly the kind of one-line
  reach AGENTS.md commandment 4 forbids. A future single-owner integration task (ORCH-sequenced, matching
  the `apps/*` workspace-registration precedent above) can add the mount to `control-api` when E9.1b/c
  need it; until then `vite build`'s `dist/` output is a complete, deployable static bundle on its own.

  Installed deps via `pnpm install` (network reachable, verified `curl -I` against npmjs registry first) —
  react, react-dom, react-router-dom, vite, vitest, @vitejs/plugin-react, @testing-library/{react,jest-dom,
  user-event}, jsdom. This is the FIRST package under `apps/`, so `pnpm install` necessarily rewrote
  `pnpm-lock.yaml` (adding this package's own deps only — no other package's manifest touched). The
  project's own `territory-precommit` hook mechanically rejected staging that file ("outside Owned_Paths"),
  confirming it is not mine to commit — left unstaged/uncommitted in the worktree, exactly the
  precedent noted above for `pnpm-workspace.yaml`/`vitest.workspace.ts`. **ORCH will need to run `pnpm
  install` (or otherwise regenerate the lockfile) once after merging this branch** so a fresh clone/CI run
  resolves `apps/dashboard`'s dependencies; flagging this explicitly rather than leaving it implicit.

  Test evidence (all commands run from the worktree root unless noted):
  - `pnpm test` inside `apps/dashboard`: 2 files, 3 tests, all pass (login redirect, full login→run-list
    flow via a stubbed `fetch`, run-detail audit-trail render).
  - `pnpm typecheck` inside `apps/dashboard`: clean, no errors.
  - `pnpm build` inside `apps/dashboard`: `tsc` clean + `vite build` succeeds, emits `dist/index.html` +
    `dist/assets/index-*.js` (239.64 kB, 76.57 kB gzip).
  - `pnpm -r build` (root): all 17 buildable workspace packages succeed, including `apps/dashboard`.
  - `pnpm -r test` (root): `apps/dashboard` 2 files / 3 tests pass. **Pre-existing, unrelated failure**:
    `packages/memory/src/memory.test.ts` — 5/7 tests fail with `there is no unique or exclusion constraint
    matching the ON CONFLICT specification` inside `packages/memory/src/facts.ts`'s `INSERT ... ON
    CONFLICT`. This is a DB-migration/schema issue in a package this branch never touches (not in
    `Owned_Paths`, no file under `packages/memory/**` appears in `git diff main...HEAD --stat` for this
    branch) — flagging for ORCH per the CLAUDE.md full-suite-review amendment rather than attempting a
    fix outside my territory. Every other package's tests pass.
  - `pnpm lint` (root, eslint over the whole repo): clean, 0 errors.
  - `pnpm canaries` (root, evals-harness CAN-01..09 suite): 11 files / 17 tests, all pass.

  Committed to `task/TASK-102-s5` (commit `dc8fcc8`, `feat(dashboard): scaffold Vite+React SPA with login,
  run list, run detail (E9.1a) [TASK-102]`) — 18 files under `apps/dashboard/**` plus this dossier;
  `pnpm-lock.yaml` deliberately left out of the commit per the territory hook above. Handing to
  `needs_review`.
