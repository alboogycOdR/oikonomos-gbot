# ADR-013 — Tool-name → capability resolution: a declaration-verified registry in `packages/broker`, built-in tools as a reviewed table, Postgres as the enabled/grant authority

**Status:** Proposed (Fable design session, 2026-09-03; implementing tasks require adversarial review by a model other than their author)
**Date:** 2026-09-03
**Author:** Fable 5.1, from `specs/OIKONOMOS_CAPABILITY_RESOLUTION_PROBLEM_STATEMENT.md` (ORCH, 2026-09-02)
**Related:** ADR-001 (L1 is the enforcement point), ADR-003 (`max_tier` is a ceiling), ADR-005 (liveness), ADR-008 (manifest location); CLAUDE.md non-negotiables #1, #3; `docs/STUDY-grok-bot-018.md` Tier 1 §4, §6, §7, §8; PLAN.md TASK-066, TASK-111

---

## Context

`handlePreToolUse` (`packages/broker/src/index.ts`) receives the raw tool name the model attempted — `Bash`, `mcp__gmail__send_message` — and asks `BrokerDependencies.getCapability(toolName)` which governed capability that is. No production implementation exists; every real caller is a test fixture with a hard-coded map. TASK-111 (chat task→run driver) is blocked on exactly this, and CX was right to refuse to invent it: the mapping *is* the authorization boundary.

### Corrections to the problem statement, from reading the code

1. **`PolicyRegistry` already exists** — `packages/broker/src/registry.ts` (TASK-066). It is a *name-set closure check*: mounted tools ⊆ policy keys ⊆ manifest tool names, throwing `PolicyMissingError` / `StalePolicyEntryError`, and it exposes the `manifestMap` the call-time recheck consumes. Its policy values are `unknown` and nothing in production constructs it. It is the right per-run check and this ADR keeps it; it is not the process-level resolver.
2. **`scanManifests(dir)` returns validated *file names*, not manifests.** A loader that returns `ConnectorManifest[]` is a small addition to `packages/connectors`, not an existing function.
3. **`registerConnector(rawManifest, store)` already loads a manifest into Postgres** (`packages/connectors/src/registration`, `packages/db/src/capabilities.ts`): it upserts one `capabilities` row per tool and one `role_grants` row per (manifest role × tool). `seedInboxTriage.ts` duplicates by hand what `registerConnector(gmail.yaml)` produces.
4. **The `capabilities` table has no `tool_name` column** (`001_schema_v1.up.sql:30`). Postgres therefore *cannot* be the authority for tool-name → capability. It is the authority for `enabled` and for `role_grants`. The problem statement's "Postgres is the runtime source of truth" is true for those two things only.
5. **Connector manifests are not a protected path.** They declare `default_tier`, registration copies it into Postgres, and the broker enforces it — yet `packages/connectors/manifests/**` can be edited under an ordinary builder task with no different-model review. See Decision §9.

## Decision

### 1. Two authorities, one rule

| Question | Authority | Where it lives |
|---|---|---|
| Which tool names exist, which capability each maps to, its default tier | **Declaration** — connector manifest `tools[]` entries and the built-in table (§3), both code-reviewed | `packages/connectors/manifests/*.yaml`, `packages/broker/src/builtinTools.ts` |
| Whether a capability is currently enabled (kill switch, OIK-030) | **Postgres** `capabilities.enabled`, read per call, never cached | `packages/db` |
| What a role may do (`max_tier` ceiling, constraints) | **Postgres** `role_grants`, read per call | `packages/db` |

**Rule:** a tool resolves only when the declaration and the persisted row *agree*. Any disagreement — no row, adapter mismatch, tier mismatch, disabled — resolves to `null`, and the broker denies. There is no fallback tier, no prefix matching, no normalisation of the tool name. Exact string equality on the raw name the hook delivered.

### 2. The registry lives in `packages/broker`, in two levels

- **Process level — `CapabilityRegistry`** (new, `packages/broker/src/capabilityRegistry.ts`). Built once at process start from all declarations plus a `PersistedCapabilityReader` port (structurally satisfied by `@oikonomos/db`'s `Database`). Construction is read-only and throws on any closure failure (§5). It exposes:
  - `resolve(toolName): DeclaredCapability | null` — pure, synchronous, exact match.
  - `enabledToolNames: ReadonlySet<string>` — the declared-and-declared-enabled surface; this is what feeds `PolicyRegistry.manifestToolNames` and therefore `BrokerDependencies.manifestMap`.
  - `brokerPorts(persisted): Pick<BrokerDependencies, "getCapability" | "getRoleGrant">` — the per-call adapters in §6.
- **Run level — `PolicyRegistry`** (existing, unchanged semantics). Constructed per `composeHarness` call with `mountedToolNames` = the bare names of this run's L2 `allowedTools` (the `name` of each `ClassifiedAllowedTool`; `Read(src/**)` → `Read`), `policies` = the registry's entries, `manifestToolNames` = `registry.enabledToolNames`. Mounting an undeclared or disabled tool throws `PolicyMissingError` before any query runs.

Why broker and not policy or connectors: broker already owns `RegisteredCapability`, `PolicyRegistry`, and the error vocabulary, and its `index.ts` doc comment promised this class; it takes data through ports and does no I/O of its own, so `packages/policy`'s zero-I/O guarantee is not needed here; `packages/connectors` is not a protected path and built-in tools are not connectors. `packages/policy` gains nothing — `riskTiers`/`RiskTier` are already the shared vocabulary.

The manifest projection is pure and lives in broker too: `declaredToolsFromManifest(slice)` over the structural slice `{ connector_id, mcp_server: { name }, tools: [{ tool_name, capability_id, default_tier, enabled? }] }` — the same shape `services/worker/src/executeRun.ts` already accepts as `ConnectorManifestSlice`. `packages/connectors` only supplies `loadManifests(dir): Promise<ConnectorManifest[]>` (read + `validateManifest`, throw on any issue).

### 3. Built-in Agent SDK tools: a hand-maintained, reviewed table

`packages/broker/src/builtinTools.ts` exports `BUILTIN_TOOLS` as a frozen `as const satisfies readonly DeclaredTool[]` with `adapter: "sdk:builtin"`, `enabled: true`. v1 content:

| `tool_name` | `capability_id` | `default_tier` | Why |
|---|---|---|---|
| `Read` | `fs.read` | `T0_observe` | read-only; destination is the path, so the N13 secret-path guard still applies |
| `Glob` | `fs.read` | `T0_observe` | read-only enumeration; one grant covers the read set |
| `Grep` | `fs.read` | `T0_observe` | same |
| `Edit` | `fs.write` | `T2_internal` | mutates host-visible state; reversible via git but not a "draft" in the approval-card sense |
| `Write` | `fs.write` | `T2_internal` | same |
| `Bash` | `runtime.bash` | `T3_external` | arbitrary execution with network reach; approval on every call. Also the name under which harness-factory presents Codex/Grok subprocess spawns (`SUBPROCESS_TOOL_NAME`), so provider spawns are governed by the same row |

Everything else the SDK exposes (`WebFetch`, `WebSearch`, `Task`, `TodoWrite`, `MultiEdit`, `NotebookEdit`, `AskUserQuestion`, …) is **not declared**: it cannot be mounted (`PolicyMissingError` at run composition) and, if the model attempts it anyway, L1 denies `capability.unregistered` and L2 `dontAsk` denies it independently. That is the fail-closed default, not a gap. Adding a row is a protected-path change with different-model review; it does not require amending this ADR unless it changes a rule above.

Several tools may share one `capability_id`; the audit event still records the exact `toolName` in its payload.

### 4. Registration: built-ins reach Postgres the same way connectors do

Built-in capabilities must exist as `capabilities` rows or no `role_grants` row can reference them (FK). They are registered through the existing `ConnectorRegistrationStore.register` with `adapter: "sdk:builtin"` and **zero role grants** — the zero-grant default TASK-106/110 chose stands; a new chat bot is text-only until a grant exists. `packages/db` gains one optional field, `ConnectorRegistrationRows.adapter?: string` (default `mcp:<connectorId>`), nothing else.

Registration is an **explicit, idempotent operator/CI step** (one CLI in `services/worker`, e.g. `pnpm --filter @oikonomos/worker register-capabilities`, which registers every manifest under `defaultManifestsDir()` plus `BUILTIN_TOOLS`). **Boot never writes authorization tables.** Reasons: a process that populates its own authorization data at start cannot be told "no" by the database; and a DB-side `enabled=false` set during an incident must survive restarts, which an upsert-at-boot would silently undo.

`seedInboxTriage.ts` is superseded by `registerConnector(gmail.yaml)`; it produces the same three capabilities and the same three `inbox-triage` grants. Migrating the eval fixtures off it is optional for the first landing.

### 5. Construction-time closure checks (fail-closed by construction)

`CapabilityRegistry.build({ declared, persisted })` throws, naming the offending tool or capability, on:

| # | Check | Error |
|---|---|---|
| C1 | Same `tool_name` declared twice (across manifests, or a built-in colliding with a manifest tool) | `DuplicateToolDeclarationError` |
| C2 | Connector tool not a fully-qualified `mcp__<server>__<tool>` whose `<server>` equals the manifest's `mcp_server.name`; built-in tool not a bare `[A-Za-z][A-Za-z0-9]*` name; any name starting `mcp__` in the built-in table | `InvalidToolDeclarationError` |
| C3 | Declared `capability_id` has no `capabilities` row | `CapabilityNotRegisteredError` (message names the registration command) |
| C4 | Row `adapter` ≠ declared adapter | `CapabilityOwnershipError` |
| C5 | Row `default_tier` ≠ declared `default_tier` | `CapabilityTierDriftError` |
| C6 | A `capabilities` row under an adapter this process declares (`sdk:builtin`, or `mcp:<id>` for a loaded manifest) with no declaration — inventory drift, study §7 bidirectional closure | `StaleCapabilityRowError` |
| C7 | Zero declarations after loading | `UNOBSERVABLE` (ADR-005 §2: an empty registry is never a valid production state) |

`enabled` disagreement is **not** a construction error — that is the kill switch working. Rows under adapters this process does not declare at all are ignored: no tool name maps to them, so they are unreachable.

### 6. Call-time resolution (the `BrokerDependencies` ports)

```
getCapability(toolName):
  entry = registry.resolve(toolName)                       // exact match; null ⇒ return null
  row   = await persisted.getCapability(entry.capabilityId) // every call, never cached
  if row === null                         → null            // deregistered since boot
  if row.enabled !== true                 → null            // kill switch, OIK-030
  if row.defaultTier !== entry.defaultTier → null           // drift since boot
  return { toolName, capabilityId, defaultTier: entry.defaultTier }

getRoleGrant(roleId, capabilityId):
  row = await persisted.getRoleGrant(roleId, capabilityId)
  return row === null ? null : { maxTier: row.maxTier }
```

`maxTier` is handed to the broker's `RoleGrantCeiling`, whose semantics are already the ceiling ADR-003 requires; the composition test must still carry ADR-003's negative case (a `T1_draft` ceiling on `runtime.bash` denies `role.tier_ceiling`). `enforcementEnabled`/`enforcedActionClasses` are not declared by any source today and are omitted (the broker's legacy path); a manifest/table field for them is the extension point when Addendum F migration reaches these tools.

A disabled or drifted capability therefore audits as `capability.unregistered`. A distinct `capability.disabled` reason would need a broker change and is deferred; the deny is what matters.

### 7. Grants come from one place

`role_grants` in Postgres, for connectors and built-ins alike, via `Database.getRoleGrant`. No second grant source, no per-tool default grant, no code-level grant table. Creating grants for chat bots is an admin surface that does not exist yet (deliberately — TASK-106) and is out of scope here; TASK-111's tests seed grants with `Database.upsertRoleGrant` against real Postgres.

### 8. Liveness assertions (ADR-005), four layers

1. **Construction** (exists, keep): `registry.test.ts` — an unmapped mounted tool throws `PolicyMissingError` naming it. Extend with one case per C1–C7.
2. **Mutation ⇒ real deny** (new, `packages/broker`): build the registry from a temp copy of the real `packages/connectors/manifests/` dir and the real `BUILTIN_TOOLS`; drive `handlePreToolUse` (not `resolve()`) for `mcp__gmail__list_messages` as `inbox-triage` → allow + audit event. Rebuild from the same inputs minus that one `tools[]` entry → the same request denies `allowlist.miss` with `manifestMap` wired, and `capability.unregistered` with it omitted, and a deny audit event is recorded. Repeat with `Read` removed from an injected built-in table (`BUILTIN_TOOLS` is the default argument, not a hard import, so the test can mutate it). The assertion keys on the audit event the broker emitted, not on registry fields.
3. **Production caller** (TASK-111's acceptance criterion, CAN-09 shape): the worker's real composition root constructs the registry; a run through the chat driver produces a decision audit event whose `capability` equals the registry's resolution, against real Postgres. A fixture map is not evidence here.
4. **CI surrogate** (`infra/ci/controls-live.mjs`, new check `capability registry closure`): a probe script under `infra/ci/` builds the registry from the real declarations with a persisted-reader stub mirroring them, plus an injected mounted name `__liveness_probe__`, and must observe `PolicyMissingError` whose `toolName` is that probe and a declaration count ≥ 9 (6 built-in + 3 Gmail; the floor rises as connectors land). Exit 0 without the rejection line fails the check — the same evidence shape as the existing territory-hook check. Its induced-inert case goes into `test-controls-live.mjs` like the others.

### 9. Manifests become a protected path

Add `packages/connectors/manifests/**` to CLAUDE.md's protected-path list (adversarial review by a different model). The manifest is where a tier is decided; registration copies it into the table the broker enforces. C5 means a manifest edit alone cannot change a live tier without re-registration, but re-registration is precisely what a builder-authored connector task runs. ORCH applies this; it is a CLAUDE.md edit, not code.

### 10. Explicitly out of scope for v1

Grant admin UI/API; grant-derived mounting (mount only what the role is granted — a good follow-up, blocked today by `executeTaskRun` requiring a non-empty `allowedTools`); `WebFetch`/`WebSearch`/`Task` rows; wiring `evaluateDomainConstraint`/`evaluateRateLimitConstraint` into the broker; a `capability.disabled` audit reason.

## Consequences

- **Positive.** `getCapability` becomes real, fail-closed by construction and by call, with no test-only fixture pretending to be production. The mapping is code-reviewed in a protected path on both sides (manifest, table). The kill switch and grants stay in Postgres and survive restarts. TASK-066's registry is reused, not replaced.
- **Positive.** Drift is loud: a manifest edited without re-registration, or a row edited by hand, refuses to boot with a named error rather than enforcing a tier nobody reviewed.
- **Cost.** One explicit registration step before first boot and after any declaration change — the same class of step as migrations. One extra `SELECT` per PreToolUse call (bounded by the broker's replay cache and ADR-001 R3's 10 s deadline).
- **Cost.** A fresh chat bot can call no tool at all until someone grants it something. That is the safe default already chosen; the audit trail shows every denied attempt, which satisfies TASK-111's "an audit decision event, not just the function was called".
- **Residual risk, stated plainly.** The built-in tier table is judgment, not derivation; `fs.write` at `T2_internal` and `Bash` at `T3_external` are conservative calls an adversarial reviewer should challenge. Exact-match resolution means an SDK rename of a built-in tool silently makes it unmountable — fail-closed, but worth a note in ADR-001's monthly SDK-drift job.

## Adjacent gaps TASK-111 will hit next (not resolved here, named so CX is not blocked again)

- **`destinationFor` for built-in tools.** The secret-path guard and the action digest both consume it. Suggested v1 rule in the composition root: `input.file_path` for `Read`/`Edit`/`Write`, `input.path ?? input.pattern` for `Glob`/`Grep`, `input.command` for `Bash`, `input.to` for Gmail send; any tool whose destination cannot be derived ⇒ throw, which the broker maps to a fail-closed deny.
- **`isCapabilitiesEnabled`** has no production source. Suggested v1: read `OIKONOMOS_CAPABILITIES_ENABLED` per call and treat anything but the literal `"true"` as disabled.

## Suggested decomposition for ORCH

1. **Broker registry** — `capabilityRegistry.ts`, `builtinTools.ts`, `declaredToolsFromManifest`, `brokerPorts`, tests for C1–C7 and liveness layer 2. Protected; author ≠ reviewer model.
2. **Loader + db field** — `loadManifests(dir)` in connectors; `adapter?` on `ConnectorRegistrationRows` in db. Unprotected, small.
3. **Worker composition root + registration CLI + CI probe** — `createProductionBrokerDependencies(...)`, `register-capabilities`, the `controls-live.mjs` check and its induced-inert test. `infra/ci/**` is protected.
4. **TASK-111 resumes** on top of 1–3 with its territory extended to the composition-root file.

## References

- `specs/OIKONOMOS_CAPABILITY_RESOLUTION_PROBLEM_STATEMENT.md`
- `packages/broker/src/index.ts` (`BrokerDependencies`, `RegisteredCapability`, `RoleGrantCeiling`), `packages/broker/src/registry.ts`, `packages/broker/src/recheck.ts`
- `packages/connectors/src/manifest/{schema,scan,validate}.ts`, `packages/connectors/src/registration/index.ts`, `packages/connectors/src/enumeration/mcpNames.ts`
- `packages/db/src/{database,capabilities,seedInboxTriage}.ts`, `infra/postgres/migrations/001_schema_v1.up.sql`
- `packages/harness-factory/src/index.ts` (`SUBPROCESS_TOOL_NAME`), `packages/harness-factory/src/l2/allowed-tools.ts`
- `services/worker/src/executeRun.ts`, `evals/harness/test/can-09-worker-liveness.test.ts`
- `docs/architecture/OIKONOMOS_Build_Handover_Package_v1.0.md` §4.1, §4.2, §4.4; Master WBS OIK-030, OIK-048, OIK-049
- PLAN.md TASK-111 `Blocked_Reason` and `dossiers/TASK-111.md` on branch `task/TASK-111-cx`
