# TASK-001 — OIK-001 Monorepo scaffold

**Brief:** Create the pnpm/Node 22/TS-strict workspace skeleton every later task builds inside — ten packages and four services as minimal compiling stubs, exactly the names in Build Handover §3. Single-owner integration task: nothing else that touches root config or workspace manifests runs concurrently.

**Spec pointers:** Build Handover §3 (the layout, verbatim); WBS §5 OIK-001 (acceptance); CLAUDE.md (strict TS, conventions). apps/* is E9 — do not scaffold.

**Intended approach:** Root package.json (engines >=22, scripts: typecheck/build/test fan-out), pnpm-workspace.yaml over packages/* and services/*, tsconfig.base.json strict, vitest at workspace level. Each workspace: package.json (name @oikonomos/<n>), tsconfig extending base, src/index.ts stub, one stub test. Commit pnpm-lock.yaml. Do not edit .gitignore (ORCH-owned; node_modules/dist already covered).

## Work Log

### [2026-08-14T14:35:00Z] [GB] Session start — fresh claim, preflight

Status claimed by dispatcher; branch `task/TASK-001-gb` created from worktree HEAD `663ead4`. Dossier was empty — not a resume.

Preflight (`python scripts/preflight_paths.py TASK-001`) — c8b9872 filesystem check, pasted verbatim:

```
[preflight] TASK-001 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 15 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    package.json  -> does not exist; parent ./ exists
  NEW    pnpm-workspace.yaml  -> does not exist; parent ./ exists
  NEW    pnpm-lock.yaml  -> does not exist; parent ./ exists
  NEW    tsconfig.base.json  -> does not exist; parent ./ exists
  NEW    vitest.workspace.ts  -> does not exist; parent ./ exists
  NEW    .npmrc  -> does not exist; parent ./ exists
  NEW    .nvmrc  -> does not exist; parent ./ exists
  NEW    .editorconfig  -> does not exist; parent ./ exists
  GLOB   packages/*/package.json  -> matches nothing yet (new territory)
  GLOB   packages/*/tsconfig.json  -> matches nothing yet (new territory)
  GLOB   packages/*/vitest.config.ts  -> matches nothing yet (new territory)
  GLOB   packages/*/src/index.ts  -> matches nothing yet (new territory)
  GLOB   services/*/package.json  -> matches nothing yet (new territory)
  GLOB   services/*/tsconfig.json  -> matches nothing yet (new territory)
  GLOB   services/*/src/index.ts  -> matches nothing yet (new territory)
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

Read: Handover §3 (layout names), WBS OIK-001, Directive §1 pointers. All Owned_Paths are NEW. apps/* is E9 — will not scaffold. Will not edit .gitignore.

Test files are not in Owned_Paths. Stub tests will live as Vitest in-source tests inside each owned `src/index.ts` (plus `packages/*/vitest.config.ts`; services configure includeSource via package.json `test` script so we do not create `services/*/vitest.config.ts`).

Next: write root + 14 workspace stubs, `pnpm install`, typecheck/build/test.

### [2026-08-14T14:45:00Z] [GB] Scaffold complete — handing to review

Implemented Handover §3 layout as compiling stubs. Did not scaffold `apps/*` (E9). Did not edit `.gitignore`.

Territory notes:
- Stub tests are Vitest in-source tests inside each owned `src/index.ts` (test files are not in Owned_Paths).
- Packages have their own `vitest.config.ts`. Services have no vitest.config in Owned_Paths; their `test` script reuses `packages/shared/vitest.config.ts` with `--root .`.
- `pnpm-workspace.yaml` allowlists `esbuild` as `onlyBuiltDependencies` so Vitest's toolchain postinstall is not silently skipped (pnpm 10 default).

Test evidence (2026-08-14T14:45:00Z) [GB]:
- `pnpm install` — exit 0; lockfile written; 15 workspace projects (root + 14). esbuild postinstall ran after onlyBuiltDependencies.
- `pnpm -r typecheck` — exit 0; all 14 workspaces `tsc --noEmit` Done.
- `pnpm -r build` — exit 0; all 14 workspaces `tsc` Done.
- `pnpm -r test` — exit 0; 14/14 workspaces, 1 in-source test each (14 passed / 0 failed). Vitest 3.2.7.
- `tsconfig.base.json` has `strict: true`; no workspace sets `strict: false`.
- `.nvmrc` = `22`; every `package.json` has `engines.node: ">=22"`.
- Layout names match Handover §3 exactly; `apps/` not created.

Stopping point: needs_review. Branch `task/TASK-001-gb`. PLAN.md not touched (strict mode).

