# ADR-008 — Connector manifest location: `packages/connectors/manifests/`, not `docs/connectors/`

**Status:** accepted · **Date:** 2026-08-18 · **Author:** ORCH (decompose of E6)

## Context

Build Handover Package v1.0 §4.4 places the connector manifest at `docs/connectors/<id>.yaml`. Two things have changed since that document was written:

1. **The manifest is a machine-validated CI artifact**, not documentation. OIK-047 requires invalid manifests to be *rejected in CI*; OIK-048 consumes manifests as the input to the registration pipeline. A file that code parses, a zod schema validates, and CI gates belongs in a workspace package with its validator and tests, not in `docs/`.
2. **`docs/**` is outside builder territory** (DEVDEPARTMENT firewall, CLAUDE.md). Builders author manifests as part of connector tasks; placing manifests in `docs/` would either require firewall exceptions on every connector task or route every manifest edit through ORCH — both worse than moving the file.

An ADR is required because this conflicts with an existing document (CLAUDE.md conventions rule).

## Decision

- **Machine manifest:** `packages/connectors/manifests/<connector_id>.yaml` — schema per Handover §4.4 (content contract unchanged: `account_ownership: basileia` required, per-tool `capability_id` + `default_tier`, `role_grants`, `evals`, `review` block). Validated by the OIK-047 validator; CI-gated.
- **Human onboarding record:** `docs/connectors/<connector_id>.md` — the OIK-050 scope-minimisation justification and onboarding decision. Written by **ORCH at review time** (docs territory), following `docs/connectors/README.md`'s checklist. The Handover §3 scaffold's "one onboarding record per connector" meaning of `docs/connectors/` is preserved.
- Golden eval suites stay in `evals/` per the Handover scaffold: `evals/golden/suites/<connector_id>/`.

## Consequences

- Handover §4.4's *path* is superseded; its *content contract* stands and is the OIK-047 schema source of truth.
- The manifest's `evals.suite` field references `evals/golden/suites/<id>`.
- OIK-050's acceptance ("written scope justification in `docs/connectors/`") is satisfied by the human record, produced as a review-gate step for every connector task — no connector reaches `done` without it.
