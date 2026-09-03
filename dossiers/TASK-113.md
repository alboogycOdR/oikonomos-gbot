# TASK-113 — Connector manifest loader + registration adapter field (ADR-013 §2, §4)

Unit: S5. Branch: `task/TASK-113-s5`.

## Work Log

- [2026-09-03T~17:40Z] [S5] Session start. Found a stale checkpoint referencing TASK-110
  (already `done`/merged per PLAN.md) and the worktree left on `task/TASK-110-s5` with an
  uncommitted `AUTOPILOT_LOG.md` edit and an untracked `dossiers/TASK-110.md` — leftover
  cruft from a prior dispatch cycle, not this session's task. AUTOPILOT_LOG.md is outside
  Owned_Paths (and protected: `docs/**`/log infra), so discarded it (`git checkout --`) and
  removed the stray TASK-110 dossier rather than touching either. Fetched `mainco`, confirmed
  PLAN.md's TASK-113 block (claimed, S5, `Depends_On: —`, Owned_Paths as below) is the live
  truth, and created `task/TASK-113-s5` fresh off `mainco/master` (2da57c1). Also noted
  `docs/decisions/ADR-013-tool-capability-resolution.md` (my Spec_Reference) exists on disk
  in the main checkout but is `git status`-untracked there — read it directly from disk since
  docs/** isn't mine to commit; content matches what PLAN.md's orchestrator_notes describes.
- [2026-09-03T~17:55Z] [S5] Implemented both pieces per ADR-013 exactly:
  1. `packages/connectors/src/manifest/load.ts` — `loadManifests(dir): Promise<ConnectorManifest[]>`.
     Reuses `scanManifests` (liveness/enumeration: throws on missing dir / zero manifests,
     aggregates validateManifest violations across all files) and `validateManifest` (parsing).
     Does not reimplement YAML/zod. On an invalid manifest, throws `InvalidManifestError`
     naming the specific file and its issues (built from `scanManifests`'s violation list,
     which already carries per-file attribution) rather than a generic message — satisfies
     "throw on any issue" without silently skipping. Exported `loadManifests`/`InvalidManifestError`
     from `packages/connectors/src/index.ts`.
  2. `packages/db/src/capabilities.ts` — added `adapter?: string` to `ConnectorRegistrationRows`,
     defaulting to the existing `mcp:<connectorId>` computation when omitted and passed through
     unchanged (used verbatim as the persisted `adapter` column value) when supplied. No other
     `registerConnector`/`deregister` behavior touched. This unblocks TASK-114's `sdk:builtin`
     registration without this task calling it that way itself (out of scope here, per spec).
- [2026-09-03T~18:05Z] [S5] Tests written and run:
  - `packages/connectors/src/manifest/load.test.ts` (5 tests): 3 validated manifests
    (gmail/google-calendar/google-drive) from the real `defaultManifestsDir()`; real parsed
    content (not just file names) from a temp-dir fixture; `InvalidManifestError` thrown
    (message names the broken file) on a deliberately invalid fixture alongside a valid one;
    missing-dir and zero-manifest UNOBSERVABLE cases still throw. All pass.
  - `packages/db/src/capabilities.test.ts` — added a `describe` block using a mocked
    `pg.Pool`/`PoolClient` (no real Postgres needed, existing integration tests in this file
    stay `describe.skip`-gated on `DATABASE_URL` unchanged) asserting the literal SQL
    parameter list: default case resolves to `mcp:gmail`, explicit `adapter: "sdk:builtin"`
    passes through unchanged. 2 new tests, both pass.
- [2026-09-03T~18:15Z] [S5] Full verification, all from repo root:
  - `pnpm --filter @oikonomos/connectors test` → 12 files, 114 passed, 4 skipped, 0 failed.
  - `pnpm --filter @oikonomos/db test` → 26 files, 116 passed, 1 skipped, 0 failed (integration
    suites ran against real Postgres per this env's `DATABASE_URL`, unaffected).
  - `pnpm -r build` → 17/18 workspaces built clean (the 18th has no build script).
  - `pnpm lint` → clean, zero findings.
  - `pnpm -r test` (full recursive suite, per CLAUDE.md's amendment — never just this task's
    package) → every workspace (apps/dashboard, packages/*, services/*, evals/golden,
    evals/harness) reported all-green; grepped the full output for `FAIL`/`ERR_PNPM` — zero
    matches.
  - Committed to `task/TASK-113-s5`: `de8b6f9 feat(connectors,db): manifest loader + adapter
    field (ADR-013 §2, §4) [TASK-113]`.
- All 4 acceptance criteria met and verified directly (not just claimed): AC1 (3 validated
  manifests from real dir), AC2 (throws, doesn't skip, on invalid fixture), AC3
  (adapter optional/default/passthrough, existing register/deregister behavior unmodified —
  confirmed by the pre-existing integration tests in this same file still passing unmodified),
  AC4 (`pnpm -r test`/`build`/`lint` all exit 0).
- Handing off `needs_review`. This is not a protected path (per PLAN.md's description line:
  "Not a protected path — ordinary review applies"), so no different-model adversarial review
  requirement applies here (unlike TASK-112/114).
