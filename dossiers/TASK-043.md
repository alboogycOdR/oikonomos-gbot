# TASK-043 — OIK-047 Connector manifest schema + validator (N5)

## Brief
Zod schema + validator for connector manifests in `@oikonomos/connectors`, plus a CLI that scans `packages/connectors/manifests/**` and fails CI on any violation. `account_ownership: basileia` is the load-bearing field — this validator is the enforcement point for the platform scope boundary (N5, risk R3).

## Spec pointers
- Build Handover §4.4 — the gmail manifest example is the normative content contract; use it verbatim as the accept fixture.
- ADR-008 — manifests live in `packages/connectors/manifests/`, NOT `docs/connectors/` (that dir is the human record, ORCH territory).
- WBS OIK-047 acceptance: "`account_ownership: basileia` required; invalid manifest rejected in CI".
- ADR-005 — liveness: a scanner that finds zero manifests must fail as unobservable, never pass.

## Intended approach
- `src/manifest/schema.ts`: zod schema; tier enum from `riskTiers` (@oikonomos/db types) — one tier vocabulary.
- `src/manifest/validate.ts`: `validateManifest(raw)` → typed result with per-field violations; parse via the `yaml` package (pre-installed; TASK-026 taught us never to hand-roll YAML).
- `src/manifest/cli.ts` + package `validate` script: scan dir, print file+field per violation, exit non-zero; exit non-zero as UNOBSERVABLE on missing dir/zero matches.
- Reject credential-looking literals in `mcp_server.url_ref` (must be a `secret://` reference — N4).
- Mutation to run before claiming done: relax the `basileia` literal → a test must go red.
- Deps are pre-installed (zod, yaml). Need anything else → BLOCK, never touch root/lockfile. ORCH wires the CI job at merge.

## Work Log

- [2026-08-18T15:10:00Z] [GB] Session start. Dispatcher claimed TASK-043 (control.mode=strict — PLAN.md not touched). Worktree was on `task/TASK-042-gb`; `master` is locked by the main checkout so reset `task/TASK-043-gb` to `origin/master` (`1285d04`). Dossier brief already present; appending here. Preflight:

```
[preflight] TASK-043 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   packages/connectors/src/**  -> 1 file(s):
           packages/connectors/src/index.ts
  GLOB   packages/connectors/test/**  -> matches nothing yet (new territory)
  GLOB   packages/connectors/manifests/**  -> matches nothing yet (new territory)
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Spec read: Handover §4.4 gmail example is the accept fixture (verbatim). ADR-008 relocates the file to `packages/connectors/manifests/` and says `evals.suite` references `evals/golden/suites/<id>`; the Handover fixture uses `evals/golden/gmail`. Schema will accept any `evals/golden/**` path so the verbatim fixture passes and ADR-008 paths also pass. `package.json` is NOT in Owned_Paths and has no `validate` script — implementing CLI as `src/manifest/cli.ts` (`runValidateCli`); ORCH wires `pnpm --filter @oikonomos/connectors validate` at merge per the task text. Next: schema + validator + tests.

- [2026-08-18T15:20:00Z] [GB] Implementation complete. Schema + `validateManifest` + dir scanner + CLI (`runValidateCli`). Live `packages/connectors/manifests/gmail.yaml` is the Handover §4.4 example verbatim (so the default-dir scan is not vacuously empty). `evals.suite` accepts any `evals/golden/**` path. `riskTiers` re-exported by identity from `@oikonomos/db`. `package.json` still has no `validate` script (outside Owned_Paths); CLI entry is `src/manifest/cli.ts` — suggested wire at merge: `"validate": "node dist/manifest/cli.js"` after build.

  MUTATION-PROVEN: temporarily changed `account_ownership` from `z.literal("basileia")` to `z.string()`. Two tests went RED:
  1. `is a ZodLiteral of basileia` — `expected ZodString to be an instance of ZodLiteral`
  2. `rejects a non-basileia account_ownership` — `expected true to be false` (`result.ok` became true for `client`)
  Restored the literal; 22/22 green.

  Tests: `pnpm --filter @oikonomos/connectors test` 22/22 pass. `pnpm --filter @oikonomos/connectors typecheck` exit 0. `pnpm -r test` exit 0. `pnpm lint` exit 0. `pnpm canaries` 15 passed / 2 skipped (DB-bound CAN-06/07 variants), exit 0. Ready for review.

