# TASK-007 — OIK-019 packages/policy risk-tier resolution (BACKLOG, TBD — GB or CX ONLY, never S5) ⚑ protected

**Brief:** Pure-function risk-tier resolution: more-restrictive-wins, unregistered ⇒ deny, 100% branch coverage. Protected path — assignment restricted to GB or CX so ORCH's opus review satisfies the different-model rule (directive §3).

**Spec pointers:** Handover §4.2 (effectiveTier = max(default_tier, roleGrantOverride); unregistered toolName ⇒ deny, audit capability.unregistered). WBS OIK-019. Directive §4 fail-closed. TASK-005's lint rule enforces the zero-I/O property mechanically.

**Intended approach:** Tier enum ordering utilities + resolve() over capability rows and role grants (passed in as plain data — no I/O). Exhaustive branch matrix test; Vitest coverage gate at 100% branches for this package.

## Work Log

- [2026-08-15T06:00:00Z] [CX] Started on `task/TASK-007-cx`. Preflight evidence: `[preflight] TASK-007 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos`; `packages/policy/src/**` has 1 file (`src/index.ts`); `packages/policy/test/**` is new territory; `packages/policy/package.json`, `packages/policy/vitest.config.ts`, and `pnpm-lock.yaml` exist. Implementing the pure tier resolver and its 100%-branch coverage gate.
- [2026-08-15T06:08:32Z] [CX] Completed the pure resolver, full tier matrix tests, and V8 branch gate. `pnpm --filter @oikonomos/policy test -- --coverage` passed 9/9 with 100% statements, branches, functions, and lines. `pnpm --filter @oikonomos/policy typecheck`, `build`, scoped ESLint, workspace `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm install --frozen-lockfile` all exited 0; the DB integration suite correctly skipped its two DATABASE_URL-dependent tests.
