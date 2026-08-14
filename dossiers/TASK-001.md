# TASK-001 — OIK-001 Monorepo scaffold

**Brief:** Create the pnpm/Node 22/TS-strict workspace skeleton every later task builds inside — ten packages and four services as minimal compiling stubs, exactly the names in Build Handover §3. Single-owner integration task: nothing else that touches root config or workspace manifests runs concurrently.

**Spec pointers:** Build Handover §3 (the layout, verbatim); WBS §5 OIK-001 (acceptance); CLAUDE.md (strict TS, conventions). apps/* is E9 — do not scaffold.

**Intended approach:** Root package.json (engines >=22, scripts: typecheck/build/test fan-out), pnpm-workspace.yaml over packages/* and services/*, tsconfig.base.json strict, vitest at workspace level. Each workspace: package.json (name @oikonomos/<n>), tsconfig extending base, src/index.ts stub, one stub test. Commit pnpm-lock.yaml. Do not edit .gitignore (ORCH-owned; node_modules/dist already covered).

## Work Log
