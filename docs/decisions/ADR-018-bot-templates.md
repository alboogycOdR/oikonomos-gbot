# ADR-018 — Bot templates: a refuse-on-secret manifest that never grants, internal-only with an import-ready shape

**Status:** Accepted (2026-09-12, after adversarial review by CX9 / Codex GPT — accept-with-changes, both required changes applied below; see `ADR-018-review-cx9-2026-09.md` for the full verdict). Implementing tasks on `packages/templates` export/install and the control-api routes require adversarial review by a model other than their author — by policy, per ADR-012 §6, since this is a secret-egress and grant boundary even though the paths are not on the CLAUDE.md protected list. **The "Amendment 2026-09-16" section below is Accepted (2026-09-16, after adversarial review by CX9 / Codex GPT — reject then accept-with-changes across two implementation attempts; see `ADR-018-review-amendment-cx9-2026-09.md` for the full verdict and required changes, both applied in TASK-264).**
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

### 2. Export and install refuse on any credential match under a template-specific policy; they never redact

The exporter walks every string in the manifest, recursively, through a **template credential policy** that is strictly wider than the audit matcher (review change 1). The policy, `packages/templates/src/credentialPolicy.ts`, refuses a string that matches any of:

1. the eight audit pattern families (`matchesSecretPattern`, reused, never copied);
2. **JWT shape** — three base64url segments separated by dots whose first segment decodes to a JSON object with an `alg` or `typ` key;
3. **credential-bearing URLs** — any URL with userinfo (`scheme://user:pass@host`) or a query/fragment key matching `/^(token|access_token|id_token|key|api[_-]?key|secret|password|pwd|sig|signature|auth|authorization|credential|session)$/i`;
4. **opaque secret-like blobs** — a single token of ≥ 32 characters drawn from the base64/base64url or hexadecimal alphabets whose Shannon entropy exceeds 4.0 bits per character, unless it is on the manifest's own **allowlist of structural identifiers** (skill names, capability ids, cron strings, which are all short or low-entropy by construction);
5. any `secret://` reference.

A match aborts with 422 and the JSON-pointer paths of the offending fields — never the matched text — and writes `template.export_refused {field_paths, classes}`. Install repeats the scan on the stored manifest. Redaction was rejected because a redacted template silently ships a bot with a hole where its key was, which is the second most common Grok Bot template complaint after the leak itself. Refusal forces the fix at the source.

**Split credentials (review change 1, threat model stated).** The policy scans each string and, additionally, the **canonical serialization** of the manifest with all string values joined in canonical field order by a single separator, so a credential that a creator pasted across two adjacent prose fields (description then instructions; a routine's definition then its name) is still caught. A credential deliberately split across non-adjacent fields by its own owner is outside the threat model: the product defends against accidental leakage by a creator, not against a creator exfiltrating their own key through their own template, which no scanner can distinguish from prose. The schema keeps the number of free-prose fields small (`identity.description`, `identity.instructions`, skill `body`/`description`/`when_to_use`, routine `definition`, memory `value`) and every other field is an enum, id, cron string or short name, so the split surface is bounded and enumerated in the spec.

Negative tests exist per class (JWT, URL-userinfo, URL-query-token, high-entropy blob, `secret://`, each of the eight families, and the adjacent-field split), all built from fragment-assembled fixtures so no test file carries a credential-shaped literal.

This is a mechanical control and therefore carries a **liveness assertion** (ADR-005): a test proves the scan runs in the production route composition by exporting a role whose instructions contain a fragment-assembled key-shaped string and keying on the audit event and the absent row.

### 3. Install writes exactly the audited built-in floor and no template-derived grant; the installer grants integrations, one at a time, through the existing route

Review change 2 corrected an overclaim: `POST /roles` (`services/control-api/src/app.ts:1086-1105`) writes one `role_grants` row per `sdk:builtin` capability for every new bot, so "zero grant writes" was false the moment install reused that path. The decision is now stated precisely:

`POST /templates/:id/install` creates a role through the same path as `POST /roles`, and that path performs **exactly the built-in floor writes** — one `role_grants` row per capability in `BUILTIN_TOOLS` at its declared default tier, the identical set every human-created bot receives — and **no grant derived from the template**. It then copies skills, creates routines **paused and unbudgeted**, writes opt-in profile memories, and returns a **grant checklist** derived from `integrations[]`: each entry's status is `available`, `unknown_capability` or `disabled` according to `CapabilityRegistry`. The human grants each integration through `POST /roles/:roleId/grants` at or below the requested tier.

The test boundary is the database, not a port spy: the install integration test snapshots `role_grants` for the new role after the transaction and asserts **set equality** with the built-in capability-id set from `BUILTIN_TOOLS` (so an added or removed built-in fails the test and is reviewed), and asserts that no capability id named in `integrations[]` appears. A second test installs a template whose `integrations[]` names a granted-tier capability and proves the installed role cannot invoke it until the human grants it (L1 deny `capability.unregistered`/no grant).

Consequences that follow without extra code: a template cannot reference a connector outside the Basileia scope boundary, because only `account_ownership: basileia` manifests can be registered and only registered capability ids resolve; a template cannot raise a tier, because the installer's grant is bounded by the capability's declared tier exactly as any grant is.

### 4. Internal-only in v1; the shape is import-ready, the code is not

No code path in v1 reads a template from outside the tenant's own `bot_templates` rows. `visibility` is a CHECK-constrained `'private'`. The manifest's top-level keys (`identity`, `skills`, `routines`, `integrations`, `memories`) deliberately mirror the public Grok Bot template vocabulary so that a later, separately decided converter could **map declarative content** from a public template into this shape. Two things are unimportable by construction regardless of any future converter: executable content (scripts, MCP servers, plugin bundles — parity disposition row 15 already rejects these) and grants (§3). The trade-off is recorded: an internal-only v1 forgoes the marketplace's network effect; it gains a template that cannot leak, cannot grant, and cannot run untrusted code, which are the three documented failure modes of the public ecosystem. Revisit when there is a second tenant.

### 5. Routines travel paused and unbudgeted; memories travel only by explicit opt-in

A routine that fires on install is the "run one supervised test before enabling routines" guidance turned into a default. Budget is a per-installation decision, not a recipe property. Memory is the most private thing a bot holds; the export UI lists profile-tier facts and the default selection is none.

## Resolution — both required changes applied 2026-09-12

- Change 1 (credential policy beyond the eight families; split-credential threat model) → §2 rewritten: five detector classes, canonical-serialization adjacency scan, bounded and enumerated prose surface, per-class negative tests. `specs/OIKONOMOS_TEMPLATES_v1.0.md` §3.2 and §10 updated to match.
- Change 2 (grant contradiction) → §3 rewritten to the reviewer's second option: install performs exactly the audited built-in floor and no template-derived grant, proven by set equality against `BUILTIN_TOOLS` at the database, not by a port spy. Spec §5.2 and §10 updated.

## Consequences

- New: `packages/templates` (zero-I/O, including `credentialPolicy.ts`), two tables, five routes, audit events `template.exported`, `template.export_refused`, `template.install_refused`, `template.installed`.
- Unchanged: ADR-013's two authorities; `packages/connectors/manifests/**`; the grant route; `POST /roles`.
- Review: the export scan and the install/grant boundary get adversarial, different-model review by policy.
- Sequencing: the routes share `app.ts`/`openapi.ts`/`ports.ts` with Wave Workspace-1's TASK-237/238/242 and follow them, or take a dedicated routes file registered by a one-line integration task.
- Open for a later ADR: team/public visibility, signing, upgrade-in-place of an installed bot, and any external import converter.

## Amendment 2026-09-16 — the built-in floor is the wrong boundary; widen it to a named default-tool set, not an adapter tag

**Trigger:** found live, not theoretically. A freshly-created bot (`maximus`, TASK-263's incident) was asked for the weather and correctly refused to fabricate an answer — but the refusal happened because the bot holds *no* way to look anything up at all, not because a look-up was denied on policy grounds. The owner asked, correctly, why a generic tool like web browsing needs the same manual per-capability grant call as linking a real Gmail account, when the public Grok Bot product the owner is replicating makes tools available the moment you sign in and only gates account-linked connectors behind an explicit connect step.

**Diagnosis.** §3's "built-in floor" is implemented in `services/control-api/src/app.ts`'s `POST /roles` handler as `capabilities.adapter === 'sdk:builtin'` — a filter on *implementation detail* (is this capability implemented as an in-process SDK tool or an MCP server call?), not on the property that actually matters for whether a human's consent is needed first: **does invoking this touch one specific external account/mailbox/calendar that belongs to someone, or is it a shared, sandboxed, Basileia-owned tool with no personal data behind it at all?** Checked directly against the live `capabilities` table:

| Capability | Adapter | Touches a personal account? |
|---|---|---|
| `fs.read`, `fs.write`, `runtime.bash` | `sdk:builtin` | No | 
| `browser.session`, `browser.navigate`, `browser.read`, `browser.interact`, `browser.screenshot` (Steel) | `mcp:steel-browser` | No — a Basileia-owned sandbox, `account_ownership: basileia` |
| `workspace.rename_self`, `workspace.send_to_role`, `workspace.create_routine` | `mcp:workspace` | No — core product self-management, not an external account at all |
| `workspace.request_secret` | `mcp:workspace` | No, but genuinely consequential (asks a human to hand over a credential) |
| Gmail / Calendar / Drive (all tools) | `mcp:gmail`/`mcp:google-calendar`/`mcp:google-drive` | Yes — a specific mailbox/calendar/drive with real content |

The adapter tag happens to correlate with this distinction for exactly the three original `sdk:builtin` tools, which is why the contradiction sat unnoticed since ADR-018's original acceptance.

**Decision.** Replace the adapter-tag filter with an explicit, named **default capability set**, `DEFAULT_ROLE_CAPABILITIES`, checked in at `services/control-api/src/defaultCapabilities.ts` (new file, not protected-path, but held to this ADR's own adversarial-review requirement below same as §3's original floor):

```
fs.read, fs.write, runtime.bash,                                   // unchanged (sdk:builtin)
browser.session, browser.navigate, browser.read,
browser.interact, browser.screenshot,                               // new — Steel, no personal account
workspace.rename_self, workspace.send_to_role, workspace.create_routine  // new — self-management, no personal account
```

Each entry is granted at its manifest-declared `default_tier` exactly as today's floor already does — this amendment changes *which* capabilities are in the floor, not the tier-resolution mechanism. `workspace.request_secret` and every Gmail/Calendar/Drive capability are deliberately **excluded** and remain manual-grant-only: the first because handing over a credential is consequential regardless of account ownership, the second because they are exactly the account-linked case the owner named as correctly requiring an explicit step.

`POST /templates/:id/install` (§3) inherits this widened floor automatically, since it creates a role through the same `POST /roles` path — no separate change needed there, but the install test's set-equality assertion (§3, "asserts set equality with the built-in capability-id set from `BUILTIN_TOOLS`") must be updated to assert equality against `DEFAULT_ROLE_CAPABILITIES` instead, or it will fail the moment this lands.

**Consequence for §3's own security property:** a template's `integrations[]` list still can never grant anything — it can still only ever contain capabilities *outside* `DEFAULT_ROLE_CAPABILITIES` (a Steel or workspace capability can never legitimately appear there anymore, since it's now part of the automatic floor every role gets regardless of any template). The install test naming §3's grant boundary should add an explicit assertion that no `DEFAULT_ROLE_CAPABILITIES` member ever appears in a template's `integrations[]` — if one did, that would itself be a spec/tooling bug worth catching mechanically, not silently accepted as redundant.

**Resolved by the adversarial review:** `browser.interact` (T2_internal — the one member of the candidate set capable of mutating a live page: click/type/fill) stays **manual-grant-only**. The reviewer's verdict: a Basileia-owned sandbox session avoids a personal-account grant, but does not remove the capability to submit forms or otherwise mutate a live site, and that is a real human product/security decision this ADR should not make by default. `DEFAULT_ROLE_CAPABILITIES` therefore has ten members, not eleven: three original + four read-only/session Steel capabilities (`browser.session`, `browser.navigate`, `browser.read`, `browser.screenshot`) + three workspace capabilities.

**Review requirement.** Per this ADR's own header, any change to `services/control-api`'s grant boundary requires adversarial review by a model other than its author. This amendment is authored by ORCH (Claude Sonnet 5); implementation and review both go to builders under that same different-model constraint.

**Spec follow-up (ORCH, after this amendment's implementation merges):** `specs/OIKONOMOS_TEMPLATES_v1.0.md` §3.2, §5.2, §10 all currently say "built-in floor" / `BUILTIN_TOOLS` where this amendment now means `DEFAULT_ROLE_CAPABILITIES` — builders never touch `specs/**` (protected path), so ORCH updates the spec text directly once the implementing task's exact naming is confirmed, not before.
