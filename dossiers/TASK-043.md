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
