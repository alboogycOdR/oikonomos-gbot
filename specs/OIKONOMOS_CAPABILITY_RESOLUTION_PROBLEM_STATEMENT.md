# Problem statement: production `getCapability(toolName)` resolution

Written 2026-09-02 (ORCH) for a Fable design session, after CX correctly
refused to invent this boundary while working TASK-111 (chat task→run
execution driver). Handed to Fable deliberately: this is a real
authorization-design question, not an implementation detail, and CLAUDE.md
requires protected-path work (`packages/broker/**`, `packages/policy/**`)
be reviewed by a different model than its author — doing the *design* on
a different model than the eventual implementer is the same discipline
applied one step earlier.

## The gap, precisely

`packages/broker`'s `BrokerDependencies` interface (`packages/broker/src/
index.ts:78-103`) requires:

```ts
getCapability(toolName: string): Promise<RegisteredCapability | null>;
getRoleGrant(roleId: string, capabilityId: string): Promise<RoleGrantCeiling | null>;
```

`getCapability` is called by `handlePreToolUse` (the PreToolUse hook —
CLAUDE.md non-negotiable #1, the sole enforcement point) with the **raw
tool name the model actually attempted to call** — e.g. `Bash`,
`mcp__gmail__send_message`. Its job is to answer "what governed capability
does this concrete tool call correspond to, if any" so the broker can then
look up the role's grant ceiling for that capability and decide.

**No production implementation of this function exists anywhere in the
codebase.** Every real usage found is a test fixture that hardcodes a
handful of tool names (`services/worker/test/fixtures.ts`,
`evals/harness/test/helpers.ts`'s `TIER3_TOOL`/`tier3Capability`). There is
no code that, given an arbitrary real tool name at runtime, returns the
right answer — or correctly returns "no capability, deny" for an
unrecognized one (CLAUDE.md non-negotiable #3, fail closed).

## What already exists (real, reusable — do not rebuild)

1. **Connector manifests are real and already declare the mapping** for
   MCP/connector tools. `packages/connectors/manifests/{gmail,
   google-calendar,google-drive}.yaml` each list `tools: [{tool_name,
   capability_id, default_tier, enabled?}]` — e.g. `gmail.yaml`:
   ```yaml
   tools:
     - tool_name: mcp__gmail__list_messages
       capability_id: email.list
       default_tier: T0_observe
     - tool_name: mcp__gmail__send_message
       capability_id: email.send
       default_tier: T3_external
       enabled: false
   ```
   Schema: `packages/connectors/src/manifest/schema.ts`
   (`connectorManifestSchema`, zod-validated, `.strict()`). Scanning:
   `packages/connectors/src/manifest/scan.ts`'s `scanManifests(dir)` —
   real, used by CI's `pnpm --filter @oikonomos/connectors validate` step
   — returns validated `ConnectorManifest[]` for every file in
   `packages/connectors/manifests/`.
2. **`packages/db`'s `Database` class has real, Postgres-backed capability
   and grant lookups** (`packages/db/src/database.ts`):
   `getCapability(capabilityId)` (looks up by the *already-known*
   capability_id — it does not resolve from a tool name), `getRoleGrant
   (roleId, capabilityId)`, `listCapabilities()`, `upsertCapability()`,
   `listRoleGrants()`, `upsertRoleGrant()`. These are correct and tested;
   they are the persistence layer once you already have a capability_id.
3. **`packages/db/src/seedInboxTriage.ts`** manually inserts three
   `Capability` rows + matching `role_grants` for Gmail, mirroring
   `gmail.yaml`'s content — but by hand, not by reading the manifest. It
   is the only capability data that has ever actually reached Postgres.
4. **A narrower, unrelated mechanism already exists and must not be
   confused with this one**: `packages/broker/src/recheck.ts`'s
   `ManifestMap`/`recheckAgainstManifest` is a call-time *presence* check
   (TASK-066/068, "is this tool still on the enumerated list") — a
   defense against a stale tool list, not capability resolution. It's the
   optional `manifestMap` field on `BrokerDependencies`. Solving this
   problem statement does not require touching it, though the same
   underlying manifest data plausibly feeds both.

## What's missing

1. **A runtime registry** that aggregates every installed connector
   manifest's `tools[]` into a `tool_name → {capability_id, default_tier}`
   lookup, and a real `getCapability(toolName)` built on top of it that:
   reads the manifest-derived default, cross-references/overrides with
   whatever is actually persisted in `capabilities` (Postgres is the
   runtime source of truth; the manifest is the seed/declaration), and
   returns `null` — not a guess — for anything unrecognized. `packages/
   broker/src/index.ts`'s own doc comment already anticipates a
   `PolicyRegistry` class "constructed by production callers, throws on
   incompleteness" — that class does not exist yet under that or any
   other name. Whether to build it in `packages/policy` (zero I/O,
   lint-enforced — so it would need to be handed already-loaded manifest
   data, not read files itself) or `packages/connectors` (which already
   owns manifest I/O) is part of what needs deciding.
2. **Built-in Agent SDK tools have no manifest at all.** `Bash`, `Read`,
   `Edit`, `Write`, `Grep`, `Glob`, `WebFetch`, etc. are not MCP/connector
   tools — nothing in `packages/connectors/manifests/` covers them, and
   nothing else declares their capability/tier mapping in production
   either. Test fixtures invent ad hoc mappings per test
   (`evals/harness/test/helpers.ts`'s `TIER3_TOOL`/`tier3Capability`,
   `services/worker/test/fixtures.ts`'s `WORKER_TOOL`). Every real run
   that ever attempts a built-in tool needs a real answer here, and there
   isn't one. This is arguably the harder half of the problem: connector
   tools have a natural home (the manifest); built-ins don't have an
   obvious equivalent registration point yet.
3. **A decision on where role_grants come from for built-ins**, mirroring
   `getRoleGrant`'s existing DB-backed shape — probably straightforward
   once (2) is decided, but explicitly in scope.

## Constraints this design must satisfy

- **CLAUDE.md non-negotiable #3, fail closed**: an unmapped/unrecognized
  tool name must resolve to "no capability" → broker denies. Never a
  default-allow, never a permissive fallback tier.
- **CLAUDE.md non-negotiable #7 is not directly implicated (no vector
  work here), but the general pattern applies**: the authorization check
  happens *before* anything else, never inferred after the fact.
- **`packages/policy` has zero I/O imports (lint-enforced)** — if the
  registry construction logic needs to live there, it must be handed
  already-loaded data by its caller, not read files/DB itself.
- **ADR-005 control-liveness**: whatever ships needs a liveness assertion
  that fails when the mapping goes inert — e.g., a mutation test proving
  that deleting a manifest's `tools[]` entry (or the built-in registry
  entry) actually denies that tool at runtime, not just that the registry
  object "looks complete." A construction-time "throws on incompleteness"
  check (as the existing doc comment on `PolicyRegistry` anticipates) is
  the right shape per the Grok Bot study's Tier-1 pattern #4
  (`docs/STUDY-grok-bot-018.md` §4).
- **This touches `packages/broker/**` and likely `packages/policy/**`,
  both protected paths** — CLAUDE.md requires adversarial review by a
  model different from the author before merge, regardless of who
  designs it.
- Scope: this only needs to unblock **TASK-111** (chat bots making real
  tool calls) and the **already-real Gmail inbox-triage path** (which
  today works only because of the hand-seeded DB rows in
  `seedInboxTriage.ts` — a real design should ideally let that seed step
  be replaced by "load the manifest," though migrating it is not
  mandatory for a first landing). It does not need to solve every future
  connector or every possible built-in tool on day one — a registry that
  is correct and fail-closed for an initially-small, explicit tool set,
  with a clear extension point, is an acceptable first landing.

## What "solved" looks like

A real, production `getCapability(toolName): Promise<RegisteredCapability
| null>` (and whatever built-in-tool grant source `getRoleGrant` needs)
that: is constructed once at process startup (not per-call), throws at
construction if it can't fully resolve its inputs (fail-closed by
construction, not by luck), is exercised by a liveness test that proves a
removed mapping entry actually causes a real deny (not merely that a
registry field is empty), and has an explicit, written answer for how
built-in Agent SDK tools get their capability/tier — even if that answer
for v1 is "a small, hand-maintained, explicitly reviewed table," as long
as it's real code with a real fail-closed default, not another set of
test-only fixtures pretending to be the production path.

## Deliverable expected back from Fable

A design (ADR-track, since this is a material cross-cutting security
decision per CLAUDE.md's ADR criteria) covering: where the registry lives
(package/module), how connector-manifest data and built-in-tool data are
reconciled into one `getCapability`, the construction-time completeness
check, and the liveness-assertion shape. Implementation, if Fable's
session has time/scope for it, is welcome but the design is the required
output — ORCH will decompose it into a properly-scoped, adversarially-
reviewed task either way.
