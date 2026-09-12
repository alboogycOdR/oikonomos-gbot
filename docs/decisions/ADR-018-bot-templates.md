# ADR-018 — Bot templates: a refuse-on-secret manifest that never grants, internal-only with an import-ready shape

**Status:** Proposed (Fable 5.1 design session, 2026-09-12; implementing tasks on `packages/templates` export/install and the control-api routes require adversarial review by a model other than their author — by policy, per ADR-012 §6, since this is a secret-egress and grant boundary even though the paths are not on the CLAUDE.md protected list)
**Date:** 2026-09-12
**Author:** Fable 5.1, from `docs/research/fable-brief-templates-project-manager-bot-2026-09-12.md`
**Related:** `specs/OIKONOMOS_TEMPLATES_v1.0.md` (the spec this decides for); ADR-013 (declaration-verified registry — templates reference capability ids, never declare them); ADR-008 (manifest location — templates never write there); ADR-014 (vault — `secret://` refs never travel); CLAUDE.md non-negotiables #4 (no credentials) and #5 (Basileia-owned accounts only); parity disposition row 20.

## Context

Skills are live in production (TASK-224 closed the last wiring gap), so a bot now has something worth packaging beyond a description: identity, skills, routine specifications, connector needs and selected memory. The public Grok Bot template ecosystem (518 templates on one index alone, 2026-09-12) shows both the demand and the documented failure: a template link exposes the bot's configuration verbatim, and creators have shipped API keys left in descriptions and routine text because the product does not scrub for them. The brief asks that OIKONOMOS close this mechanically.

Three things about this codebase shape the decision:

1. The secret matcher already exists once, in `packages/audit/src/redact.ts` (eight pattern families, fragment-assembled so the file itself carries no key-shaped literal), and is deliberately mirrored by `hooks/lib.js` and `infra/ci/secret-scan.mjs`. A fourth copy would drift; a fourth caller of the same function will not.
2. Grants are decided by declaration plus Postgres (ADR-013). A template that could write `role_grants` would be an unreviewed tier change through the back door — exactly what ADR-013 §9 made `packages/connectors/manifests/**` protected to prevent.
3. `POST /roles` (`services/control-api/src/app.ts:1006`) already auto-grants only the `sdk:builtin` capabilities. That is the right floor for an installed bot too.

## Decision

### 1. A template is a canonical, digested manifest, stored as an immutable versioned row

Not a database copy. The manifest schema (`specs/OIKONOMOS_TEMPLATES_v1.0.md` §2) is a strict zod type in a new zero-I/O package, `packages/templates`, whose projection function `projectRoleToManifest` takes an input type that has **no fields** for grants, secrets, refs, threads, attachments, spend, audit, or ids from the source tenant. Exclusion is by type, not by filter. The digest is the single `packages/shared` canonical-JSON digest, so equal bots produce equal digests and drift (§6 of the spec) is a digest comparison.

### 2. Export and install refuse on any secret match; they never redact

The exporter walks every string in the manifest, recursively, through `matchesSecretPattern` and a `secret://` detector. A match aborts with 422 and the JSON-pointer paths of the offending fields — never the matched text — and writes `template.export_refused`. Install repeats the scan on the stored manifest. Redaction was rejected because a redacted template silently ships a bot with a hole where its key was, which is the second most common Grok Bot template complaint after the leak itself. Refusal forces the fix at the source.

This is a mechanical control and therefore carries a **liveness assertion** (ADR-005): a test proves the scan runs in the production route composition by exporting a role whose instructions contain a fragment-assembled key-shaped string and keying on the audit event and the absent row.

### 3. Install never grants; the installer does, one capability at a time, through the existing route

`POST /templates/:id/install` creates a role through the same path as `POST /roles` (so it receives only the built-in floor), copies skills, creates routines **paused and unbudgeted**, writes opt-in profile memories, and returns a **grant checklist** derived from `integrations[]`: each entry's status is `available`, `unknown_capability` or `disabled` according to `CapabilityRegistry`. The human grants each through `POST /roles/:roleId/grants` at or below the requested tier. A negative test spies the grant port and asserts zero calls from the install path.

Consequences that follow without extra code: a template cannot reference a connector outside the Basileia scope boundary, because only `account_ownership: basileia` manifests can be registered and only registered capability ids resolve; a template cannot raise a tier, because the installer's grant is bounded by the capability's declared tier exactly as any grant is.

### 4. Internal-only in v1; the shape is import-ready, the code is not

No code path in v1 reads a template from outside the tenant's own `bot_templates` rows. `visibility` is a CHECK-constrained `'private'`. The manifest's top-level keys (`identity`, `skills`, `routines`, `integrations`, `memories`) deliberately mirror the public Grok Bot template vocabulary so that a later, separately decided converter could **map declarative content** from a public template into this shape. Two things are unimportable by construction regardless of any future converter: executable content (scripts, MCP servers, plugin bundles — parity disposition row 15 already rejects these) and grants (§3). The trade-off is recorded: an internal-only v1 forgoes the marketplace's network effect; it gains a template that cannot leak, cannot grant, and cannot run untrusted code, which are the three documented failure modes of the public ecosystem. Revisit when there is a second tenant.

### 5. Routines travel paused and unbudgeted; memories travel only by explicit opt-in

A routine that fires on install is the "run one supervised test before enabling routines" guidance turned into a default. Budget is a per-installation decision, not a recipe property. Memory is the most private thing a bot holds; the export UI lists profile-tier facts and the default selection is none.

## Consequences

- New: `packages/templates` (zero-I/O), two tables, five routes, audit events `template.exported`, `template.export_refused`, `template.install_refused`, `template.installed`.
- Unchanged: ADR-013's two authorities; `packages/connectors/manifests/**`; the grant route; `POST /roles`.
- Review: the export scan and the install/grant boundary get adversarial, different-model review by policy.
- Sequencing: the routes share `app.ts`/`openapi.ts`/`ports.ts` with Wave Workspace-1's TASK-237/238/242 and follow them, or take a dedicated routes file registered by a one-line integration task.
- Open for a later ADR: team/public visibility, signing, upgrade-in-place of an installed bot, and any external import converter.
