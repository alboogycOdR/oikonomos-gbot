# OIKONOMOS Templates v1.0 — installable bot recipes

> **Changelog:** v1.1 (2026-09-12, ORCH) — §3.2, §5.2 and §10 amended to apply the two required changes from the CX9 adversarial review of ADR-018 (`docs/decisions/ADR-018-review-cx9-2026-09.md`): a five-class template credential policy with an adjacent-field split scan and a stated threat model; install proven to write exactly the built-in floor and no template-derived grant, at the database.

Written 2026-09-12 (Fable 5.1 design session from
`docs/research/fable-brief-templates-project-manager-bot-2026-09-12.md`). Decisions that
are hard to reverse live in `docs/decisions/ADR-018-bot-templates.md`; this spec is the
decompose input. Line citations are against `master` `ae122be`.

Precedence: sits alongside `OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md` (row 20 and
§3 "templates DEFER" are resolved by this document); overrides no ADR. Where it touches
grants it defers to ADR-013 unchanged.

Dependency: skills are live in production (TASK-176/177/178/224). Nothing else new is
required. Templates do **not** depend on the Project spec.

---

## 0. Dispositions of the brief's open questions

| Question | Disposition |
|---|---|
| Export format: real manifest or DB-to-DB copy? | **Manifest.** A versioned JSON document, canonicalised and digested by the single `packages/shared` implementation, stored as a row and exportable as a file. A DB copy would carry ids, grants and history that must not travel. |
| Mechanical secret detection at export? | **Refuse, do not redact.** Export runs the audit secret matcher over every string; any match aborts the export and names the field path. Same scan on install. Liveness-asserted. (§3) |
| Does install touch protected manifest paths? | **No.** A template references capability ids that must already be registered from a reviewed connector manifest. Install never writes `role_grants` and never touches `packages/connectors/manifests/**`. The exporter/installer code itself is security-relevant and gets adversarial review by policy (ADR-012 §6 precedent). (§5) |
| Versioning and drift once installed? | Template rows are immutable per version; a role records what it was installed from; drift is detected by re-projecting and comparing digests, shown, never auto-synced in v1. (§6) |
| Closed/internal, or leave room to import a public Grok Bot template's shape? | **Internal-only in v1, import-ready shape.** No code path reads an external template in v1. The manifest's top-level keys deliberately mirror the public shape (identity, instructions, skills, routines, integrations, memories) so a later converter can map declarative content; executable content and grants are never importable by construction. (ADR-018 §3) |

## 1. What a template is

1.1 A template is a **recipe, not a clone**: a declarative, versioned manifest that can
create a new, independent bot. Installing it creates a distinct role with its own
sandbox, memory, grants and history.

1.2 A template **carries**: identity (name, title, description, instructions — the
six-part charter from TASK-181 if present), provider/model preference, skills (name,
version, full body and structured fields), routine specifications (name, schedule,
definition minus any budget, skill reference by name, `on_missing_source`,
`notify_threshold`, paused), connector **declarations** (capability ids and the
requested `max_tier`, nothing else), and an explicit opt-in list of `profile`-tier
memory facts.

1.3 A template **never carries**: `role_grants` rows, approvals, `require_approval_rules`,
secret values or `secret://` refs, `secret_requests`, attachments, threads or messages,
`role_messages`, sandbox filesystem content, browser profiles, `spend_records`, audit
events, `log`/`note`-tier memory, per-routine `budgetUsd`, or any id from the source
tenant. This list is enforced by the projection (§2), not by a reviewer's memory.

## 2. Manifest

2.1 Schema (zod, strict, in `packages/templates/src/manifest.ts`, new package with zero
I/O imports, like `packages/policy`):

```
{
  template_version: 1,
  identity: { name, title, description, instructions | null, provider | null, model | null },
  skills: [{ name, version, description, when_to_use | null, body, inputs, access, approvals, failure_policy }],
  routines: [{ name, schedule, definition, skill: name | null, on_missing_source, notify_threshold, paused: true }],
  integrations: [{ capability_id, requested_max_tier }],
  memories: [{ key, value, scope: "agent", tier: "profile" }],
  provenance: { exported_at, exported_from_tenant_digest, oikonomos_version }
}
```

2.2 `digest` = `packages/shared` canonical JSON digest of the manifest with `provenance`
excluded. Two exports of an unchanged bot produce the same digest.

2.3 Routines in a manifest are always `paused: true` and carry no budget. A routine
that references a skill does so by name; the skill must be present in the same manifest.

2.4 `integrations[].capability_id` must match a capability declared in a reviewed
manifest (ADR-013 §1). Unknown ids are allowed in the manifest (for forward
compatibility) but are reported at install (§5.4).

## 3. Export

3.1 `POST /roles/:roleId/templates` with body `{name, include_memories: [factKey...]}`
projects the role into a manifest, scans it, stores it, and returns `{templateId,
version, digest}`. Tenant-scoped; 404-never-403.

3.2 **Credential scan (v1.1, per ADR-018 §2 as amended by the CX9 review).** Every
string in the manifest (recursively, arrays and nested objects) is passed through the
**template credential policy** (`packages/templates/src/credentialPolicy.ts`), which
refuses on any of five classes: (1) the eight audit pattern families via
`matchesSecretPattern` (reused, never copied); (2) JWT shape (three base64url segments,
first decoding to JSON with `alg`/`typ`); (3) URLs with userinfo or a credential-bearing
query/fragment key (`token`, `access_token`, `id_token`, `key`, `api_key`, `secret`,
`password`, `pwd`, `sig`, `signature`, `auth`, `authorization`, `credential`, `session`);
(4) opaque blobs of ≥ 32 base64/base64url/hex characters with Shannon entropy > 4.0
bits/char, unless the value is one of the manifest's structural identifiers (skill
names, capability ids, cron strings); (5) any `secret://` reference. The policy also
scans the **canonical serialization** of all string values joined in canonical field
order, so a credential split across two adjacent prose fields is caught; splits across
non-adjacent fields are outside the stated threat model (accidental leakage by the
creator), and the free-prose surface is exactly: `identity.description`,
`identity.instructions`, skill `body`/`description`/`when_to_use`, routine `definition`,
memory `value`. **Any match refuses the export** with 422 and a list of JSON-pointer
field paths plus the class names (never the matched text), and writes audit event
`template.export_refused {role_id, field_paths, classes}`. Nothing is stored.

3.3 **Liveness.** A test exports a role whose instructions contain a fragment-assembled
key-shaped string (the audit package's own fixture technique) and asserts the 422, the
`template.export_refused` event, and that no `bot_templates` row exists. A second test
proves the scan runs in the production route composition, not only in the pure
function.

3.4 The projection is a pure function `projectRoleToManifest(roleBundle)` in
`packages/templates`; the route composes it with db reads. The pure function cannot
see grants, secrets or history because its input type has no fields for them.

3.5 Export also writes `template.exported {role_id, template_id, version, digest}`.

## 4. Storage

```sql
CREATE TABLE bot_templates (
  template_id uuid NOT NULL,
  version integer NOT NULL,
  tenant_id text NOT NULL,
  name text NOT NULL,
  manifest jsonb NOT NULL,
  digest text NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);
CREATE TABLE role_template_installs (
  role_id text PRIMARY KEY REFERENCES roles(role_id),
  template_id uuid NOT NULL,
  version integer NOT NULL,
  digest text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (template_id, version) REFERENCES bot_templates(template_id, version)
);
```

4.1 Rows are immutable; a new export of the same template id is `version + 1`.
4.2 `visibility` is `private` only in v1; the CHECK is widened by a later ADR when
team/public distribution is decided.

## 5. Install

5.1 `POST /templates/:id/install` body `{version, name?}` → creates a new role via the
same path as `POST /roles` (`app.ts:1006`, including the built-in `sdk:builtin`
auto-grants that every role gets), sets title/description/instructions/provider/model,
creates skill rows (name collision: reuse if the existing skill's digest matches, else
create `name-2`), enables them for the role, creates routines **paused**, writes the
opt-in memory facts as agent-scope profile facts for the new role, and records
`role_template_installs`.

5.2 **Install writes exactly the built-in floor and no template-derived grant (v1.1,
ADR-018 §3 as amended).** The role-creation path performs the same `role_grants` writes
every human-created bot gets — one row per capability in `BUILTIN_TOOLS` at its declared
tier — and nothing else. `integrations[]` become a **pending grant checklist** returned in
the response and shown in the UI: `{capability_id, requested_max_tier, status:
'available' | 'unknown_capability' | 'disabled'}`. The installer grants each one through
the existing `POST /roles/:roleId/grants`, one at a time, at or below the requested tier.
The proof is at the database: after the install transaction, the new role's
`role_grants` capability-id set equals the `BUILTIN_TOOLS` capability-id set exactly, and
contains no id named in `integrations[]`; a second test shows the installed role is denied
an `integrations[]` capability at L1 until a human grants it.

5.3 Because only `account_ownership: basileia` connectors can be registered
(`packages/connectors/src/manifest/schema.ts`), a template cannot name a capability
outside the scope boundary; it can only name ones the platform already reviewed.

5.4 The same secret scan as §3.2 runs on the manifest at install; a match refuses with
422 and `template.install_refused`. (Defends against a manually edited row.)

5.5 The response includes a **preview**: everything that will be created, with skill
bodies and instructions rendered, so the installer reads before confirming. The UI
shows the preview and the grant checklist before the install call; the API is
two-step only in the UI (preview = `GET /templates/:id/versions/:v`).

5.6 First supervised run: the install response includes `next: "run one supervised
turn before enabling routines"`; routines stay paused until a human resumes them
(existing `POST /routines/:id/resume`).

## 6. Versioning and drift

6.1 `GET /roles/:roleId/template-status` returns `{installed_from | null, drift:
boolean, changed: [section...]}` by re-projecting the role (§3.4) and comparing the
digest per top-level section with the installed version's manifest.

6.2 Drift is shown, never auto-synced. Re-exporting a drifted role produces a new
template version. "Upgrade" (apply a newer version to an installed role) is a v2
feature; v1 offers "install as new bot" only.

## 7. Distribution

7.1 v1: private to the tenant. Listing `GET /templates` (tenant-scoped), detail,
export, install. An internal install reference `oikonomos://template/<id>@<version>#<digest>`
is a string the UI can copy; the installer verifies the digest matches the stored row
before installing.

7.2 No public index, no signing, no external import in v1. ADR-018 records why and
what the import-ready shape reserves.

## 8. UI (mobile first, dashboard second)

8.1 Bot settings → "Share as template": name, memory opt-in list (default none),
preview, export; refused exports show the field paths with "remove the secret from the
source and try again".
8.2 Templates library: list, preview, install (with the grant checklist), and a
"modified since install" badge on bots with drift.

## 9. Proposed tasks (decompose input; Owned_Paths are proposals)

| # | Scope | Owned_Paths (proposal) | Review |
|---|---|---|---|
| T-1 | `packages/templates` (schema, projection, digest, scan adapter port), migration `bot_templates` + `role_template_installs`, `packages/db/src/templates.ts` | `packages/templates/**`, `packages/db/src/templates*`, `infra/postgres/migrations/02N_bot_templates.*` | adversarial, different model (secret-scan boundary; policy per ADR-012 §6) |
| T-2 | control-api routes: export, list, detail, install, template-status; audit events; negative test on grants | `services/control-api/src/templates.routes.ts` + test, `openapi.ts`, `ports.ts` (port only) | adversarial, different model |
| T-3 | mobile: share-as-template, library, install with grant checklist, drift badge | `apps/mobile/lib/**/templates*` | standard |
| T-4 | dashboard equivalents | `apps/dashboard/src/components/templates/**` | standard |

Sequencing: T-1 → T-2 → T-3 ∥ T-4. Conflicts with Wave Workspace-1: T-2 touches
`app.ts`/`openapi.ts`/`ports.ts`, which TASK-237/238/242 own in sequence — T-2 must
follow TASK-242 or take a dedicated routes file registered from `app.ts` in a one-line
integration task.

## 10. Acceptance criteria (spec-level; tasks inherit)

- Exporting a role and re-importing it yields a role whose re-projection digest equals the template digest. (§2.2, §5.1)
- An export of a role containing a credential of any of the five policy classes (eight audit families, JWT, credential URL, high-entropy blob, `secret://`) or a credential split across two adjacent prose fields is refused with field paths and class names and no stored row; the refusal is an audit event; a production-composition liveness test proves the scan is wired; every class has a fragment-assembled negative test. (§3.2, §3.3)
- After install, the new role's `role_grants` capability-id set equals `BUILTIN_TOOLS`' set exactly and contains no `integrations[]` id; the installed role is denied an `integrations[]` capability at L1 until granted by a human; the grant checklist is returned. (§5.2)
- An `integrations[]` entry naming an unregistered capability is reported `unknown_capability` and skipped, never granted. (§2.4, §5.2)
- Installed routines are paused and have no budget until a human resumes and sets one. (§2.3, §5.6)
- A manifest never contains a `secret://` string, a role id, a grant, or an attachment id (schema-level negative tests). (§1.3)
- Drift is reported after editing the installed role's instructions and cleared after re-export. (§6)
