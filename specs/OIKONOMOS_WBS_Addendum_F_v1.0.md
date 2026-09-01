# OIKONOMOS — Work Breakdown Addendum F: the persistent office computer

**Version:** 1.0 · **Date:** 2026-09-01 · **Author:** ORCH (`claude-opus-5`)
**Authorised by:** `docs/decisions/ADR-010-persistent-office-computer-pivot.md` §5 step 2 (ACCEPTED), including its §6 amendment.
**Extends:** Master WBS + Addenda A–E.
**Primary evidence:** `docs/research/grok-bot-live-probe-2026-09-01.md` (live-instance answers, batches 1–4); `docs/STUDY-grok-bot-018.md`.
**Precedence:** ADRs > Build Handover Package v1.0 > this addendum > Gap Closure Plan v0.2 > Synthesis Spec v0.1.

---

## 0. What this document is, and what it deliberately is not

ADR-010 decided *that* OIKONOMOS becomes a persistent-environment, named-role system, and its §6 amendment decided *where the enforced line sits*. It explicitly deferred five open questions to a decompose pass. This addendum answers those five, and nothing else:

| ADR-010 §4 open question | Answered in |
|---|---|
| What "one durable environment" means technically for this stack | §2 |
| How role identity, memory and routines are persisted and schema-modelled | §3 |
| How shared workspace and session state work, and how they are protected | §4 |
| How the tier map and approval thresholds are redefined for the new autonomy default | §5 |
| Migration path for the connector/worker/harness code that already exists and works | §6 |

It is **not** a new governance model. Every CLAUDE.md non-negotiable and every prior ADR listed in ADR-010 §3 remains in force verbatim; where this document appears to touch one, it is configuring the existing mechanism, never replacing it. In particular: broker enforcement remains the `PreToolUse` hook (ADR-001), fail-closed remains absolute, and approvals remain nonce-bound and single-use (ADR-004/ADR-007) for the actions that still require one.

It is also not a licence to rewrite. TASK-052 through TASK-083 shipped a working ephemeral pipeline; §6 is deliberately a *reshape* plan, and every ticket in §9 is sized against reshaping rather than replacing.

---

## 1. The one-sentence architecture

> **A tenant owns one durable environment; named roles are addressable identities that live on it with their own memory and routines; the environment's filesystem and its connector sessions are shared across those roles; Postgres remains the durable source of truth; and the broker still gates every tool call — but the set of calls it stops has shrunk to a fixed enforced floor plus whatever a role's owner has explicitly promoted.**

Everything below is the detail of that sentence.

---

## 2. The durable environment

### 2.1 Decision F1 — one environment per **tenant**, not per role

The probe (batch 1) is unambiguous that Grok Bot provisions one cloud Linux box **per user account**, that every Bot shares its overlay filesystem, `/workspace`, Chrome profile and CLI credentials, and that the per-Bot difference is only a desktop/screen. Its own documentation warns: *"do not use separate Bots as a security boundary."*

OIKONOMOS adopts the same boundary and the same warning. **The isolation boundary is the tenant, never the role.** For Basileia today that means exactly one environment (`tenant_id = 'basileia'`), which is also the only shape N5 permits — no client or employer account may ever be represented as a role on a Basileia environment, because a role is not an isolation boundary.

Technically, the environment ("the Office") is **a long-lived container on clawsrv, managed by `infra/compose`, with durable state on named Docker volumes** rather than in the image layer. It is not a VM per role, not a sandbox per run, and not a new provider abstraction. OpenSandbox (ADR-006) is retained for its existing purpose — disposable strong-isolation compute for individual high-risk executions — and is *not* the Office; §6.4 states that relationship explicitly.

### 2.2 Decision F2 — four named durability tiers, and every write declares one

The probe's Update/Recover/Reset table is the direct source. Its most load-bearing finding is that **installed packages do not survive a rebuild** while `/workspace`, browser state and sign-ins do, and that agent memory/routines are not on the box as source of truth at all. OIKONOMOS names the equivalent tiers so that no code has to guess:

| Tier | Contents | Survives environment rebuild? | Backing store |
|---|---|---|---|
| **D0 — Record** | tasks, runs, approvals, audit events, role identity, routines, memory, evidence URIs | Yes, unconditionally — it never lived on the environment | PostgreSQL + evidence store |
| **D1 — Durable volume** | `/oikonomos/workspace/**` (shared), `/oikonomos/roles/<role_id>/**` (role-scoped working files) | Yes | named Docker volume `oikonomos-workspace` |
| **D2 — Replaceable** | image layer, installed apt/npm/pip packages, CLIs, `/tmp`, caches | **No** — rebuilt from the image | container filesystem |
| **D3 — Sealed secret** | browser profile (cookies, sessions), connector tokens, CLI credentials | Yes | volume `oikonomos-secrets`, mounted only into non-model containers (§4.3) |

Three rules follow, and each is testable:

1. **Anything that must not be lost is written to D0 or D1 with an explicit write.** State left in D2 is assumed lost. This is Addendum E's N11 ("the sandbox is disposable, Postgres is durable") restated for the Office and extended with D1, which N11 did not contemplate.
2. **D2 is never a source of truth and never an input to a governance decision.** A capability, a grant, a tier, an approval or a refusal that exists only in D2 does not exist.
3. **D3 is never readable by the model** (§4.3, N13). This is the one place this design is deliberately stricter than Grok Bot.

**Liveness assertion (ADR-005):** a *durability canary* — a marker file written into each of D1 and D2 with a run-scoped digest, and an assertion executed after a rebuild that the D1 marker is present with the identical digest and the D2 marker is absent. Keyed on evidence the volume mount emits by doing its job. A canary that only checks the compose file lists a volume is exactly the inert-control failure ADR-005 exists for and must be rejected.

### 2.3 Decision F3 — environment lifecycle verbs, and no mid-run resume

Four verbs, mapped from the probe's Update / Recover / Reset / app-update distinction:

- `provision` — first creation of the tenant environment.
- `rebuild` — fresh image, D1 and D3 volumes reattached (Grok Bot's *Update*).
- `recover` — replace an unreachable instance; identical durable-state contract to `rebuild`.
- `restore` — reattach the last **synced** volume snapshot (Grok Bot's *Reset*); the only verb that can lose D1 writes, and therefore the only one requiring an approval.

The probe is explicit that there is **no checkpoint/resume API** and that Grok Bot's own recommended model is *"cancel in-flight execution, keep the schedule, next tick starts from scratch."* OIKONOMOS adopts that model literally:

- In-flight runs are **cancelled**, not suspended, on `rebuild`/`recover`/`restore`. A cancelled run records `run_status = 'cancelled'` with a failure note naming the lifecycle verb — never a silent kill.
- **Routine definitions live in D0 and the scheduler runs off the environment**, so a rebuild can never lose a schedule. A fire whose environment is down is a *missed* fire, recorded as such, not a queued one.
- A parked approval survives a rebuild because it is D0; its run does not. Re-entry after approval starts a fresh run bound to the same approval nonce — the nonce's single-use guarantee (ADR-004) is what makes this safe, and this is the reason it must not be relaxed.

---

## 3. Named roles: identity, memory, routines

### 3.1 Decision F4 — `role_id` gains an identity table; existing grant semantics untouched

`role_id` already exists as free text on `tasks` and as the left-hand key of `role_grants`. This addendum gives it a home without changing either.

```
roles(
  role_id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT 'basileia',
  name text NOT NULL, title text NOT NULL,
  description text NOT NULL DEFAULT '',   -- the standing job. ADVISORY. see F5
  status text NOT NULL DEFAULT 'active',  -- active | hidden | deleted
  created_at timestamptz, updated_at timestamptz)
```

This is the `profile.json` (`name`, `description`, `title`) the probe found under `sand-data/agents/<uuid>/`, relocated to D0 because D0 is where OIKONOMOS keeps things that governance decisions depend on.

`role_grants.role_id` gains a foreign key to `roles`. This is the point of the table: a grant for a role that does not exist becomes impossible to insert, which closes a silent-typo path that free-text `role_id` currently leaves open.

### 3.2 Decision F5 — the role description is **advisory**; grants are the enforcer (N12)

Probe Q6 is the sharpest negative finding in the whole document: the Bot description *"is advisory in the strong sense — biases defaults and first-run, but is not a hard capability sandbox,"* and the probe Bot performed out-of-lane work on request despite its job description.

OIKONOMOS states this as an invariant rather than discovering it later:

> **N12 — A role's description is prompt material, never a control.** No enforcement decision may read `roles.description`. The enforcement inputs are `role_grants`, the enforced floor (§5.2), and require-approval rules (§5.4). A design that relies on a description to prevent an action is rejected in review.

The corresponding liveness assertion: a test that sets a role description to *"never send email"*, grants that role a send capability, and asserts the send **executes** — proving the description is not silently load-bearing. A control that appears to work only because a prompt was polite is the failure mode this test names.

### 3.3 Decision F6 — memory: three scopes, three tiers, one conflict order

Directly modelled on probe Q4, which is the most reusable finding in the probe.

**Scopes:** `agent` (one role) · `project` (a project a role has joined) · `user` (tenant-wide, every role).
**Tiers:** `profile` (injected every turn, foundational) · `log` (dated history, read on demand) · `note` (short-lived, fades).
**Conflict order:** `agent` > `project` > `user`. Exactly the probe's order; a more specific scope wins.

The existing `profile_facts` table is **extended, not duplicated** — it already carries `tenant_id, scope, key, value, source, confidence, expires_at` and a uniqueness constraint, which is four-fifths of what is needed. Migration adds `role_id` (nullable; non-null only for `agent` scope), `project_id` (nullable), and `tier`, and widens the unique key to `(tenant_id, scope, role_id, project_id, key)`.

Rules, each of which is an acceptance criterion somewhere in §9:

- **Only the `profile` tier enters the prefix every turn.** `log` is retrieved on demand, `note` carries a default 7-day TTL via the existing `expires_at`. This is the same context-budget discipline CLAUDE.md already applies to itself; unbounded memory injection is the failure this rule prevents.
- **Conflict resolution is a pure function** of (scope, key) with the order above, unit-tested against all three scopes holding the same key.
- **Memory is opt-in on write.** Probe Q5 confirmed that a receiving Bot did *not* auto-write an inbound handoff to memory. OIKONOMOS matches: nothing is written to memory as a side effect of a run; a write is an explicit, audited action.
- **Memory is not the transcript.** Conversation history stays in the run/session store keyed by `runs.session_ref`. Memory holds stable facts and preferences; changing facts belong in their source system.
- **ACL before retrieval, never after** — the existing non-negotiable applies unchanged to memory reads, and the scope filter is what implements it.

**Where we are stricter than Grok Bot (again):** the probe established that *"a Bot can `ls` another Bot's memory shard on the shared filesystem — filesystem sharing ≠ prompt injection."* Because OIKONOMOS memory lives in D0 behind a typed query layer rather than as markdown on a shared disk, a role **cannot** read another role's `agent`-scope memory at all. Cross-role sharing is done deliberately by writing to `user` or `project` scope. This costs nothing and removes a whole class of accident.

### 3.4 Decision F7 — routines are D0 rows; the scheduler is off-environment

```
role_routines(
  routine_id uuid PRIMARY KEY, role_id text REFERENCES roles(role_id),
  tenant_id text, name text, schedule text,          -- cron expression
  lane text NOT NULL DEFAULT 'background',           -- user | agent | background
  enabled boolean NOT NULL DEFAULT true,
  definition jsonb NOT NULL, last_fire_at timestamptz, next_fire_at timestamptz)
```

`tasks.routine_id` already exists and becomes a foreign key to this table. Firing a routine creates a task in the routine's lane; it does not resume anything (F3). A fire that cannot start because the environment is down is recorded as `missed`, never queued for catch-up — catch-up storms after a rebuild are the predictable failure of the alternative.

Per the ADR-010 §6 amendment, **routine creation is autonomous by default** and promotable to enforced by rule.

### 3.5 Decision F8 — role-to-role handoff is async text plus a shared-workspace pointer

Probe Q5 tested this empirically and the result is unusually clean. A handoff is:

1. **Async.** The sender gets an acknowledgement, never a reply in the same turn.
2. **Verbatim text plus sender identity.** No file bytes travel in the message — the sender passes a *path*, and the receiver reads it off the shared workspace (the probe confirmed this works and that the receiver quoted the file exactly).
3. **Zero context carry-over.** No sender transcript, no sender memory, no sender system prompt.
4. **No implicit memory write on either side.**

Modelled as `role_messages(message_id, tenant_id, from_role_id, to_role_id, body, workspace_refs jsonb, created_at, read_at)` plus one mounted tool, `send_to_role`. Per ADR-010 §6, *messaging one teammate* is autonomous by default.

The security consequence is stated here so nobody has to rediscover it: **a handoff carries no privilege.** The receiving role acts under its own grants, not the sender's. This is the same rule as R13 (an orchestrator's ceiling is independent, not the union of its subordinates'), which Addendum E §2 Finding 3 noted a comparable open-source implementation had failed to enforce.

---

## 4. Shared workspace and session state

### 4.1 Decision F9 — one shared workspace, role directories by convention only

`/oikonomos/workspace/**` is shared, D1, and readable and writable by every role on the tenant. `/oikonomos/roles/<role_id>/**` exists for tidiness, **not as a boundary** — a role can read another role's directory, and the design must not pretend otherwise. Restating Grok Bot's own warning as a rule: *roles are not a security boundary; the tenant is.*

Path handling is centralised in `services/workspace`, which is today a 13-line stub and becomes the single place that (a) resolves and normalises workspace paths, (b) rejects traversal outside the workspace root, and (c) classifies every path into a durability tier (§2.2) so that callers can be told, mechanically, that a write to D2 will not survive.

Per ADR-010 §6, **delete/overwrite on the shared environment is autonomous by default** — matching the probe's finding that a Bot can `rm` under `/workspace` with no human card — and promotable to enforced by rule.

### 4.2 Decision F10 — connector sessions are tenant-scoped and durable; the model never holds the token

Probe Q11 confirms the product contract worth copying: plugin OAuth lives on the connector backend, the model invokes tools with ordinary arguments, and **no token appears in the tool schema or result**; the model sees an opaque server-side session plus whatever identity metadata a tool chooses to return.

`packages/connectors` already implements exactly this (`mcp/oauthTokenProvider.ts`, `mcp/envSecretResolver.ts`, and the `composeHarness` contract that `mcpServers` carries already-resolved strings and is never logged, N4/N9). **Nothing about that changes.** What changes is lifetime: the session moves from per-run *create/destroy* to a tenant-scoped pool with *acquire/release*, so that "signed in once, available thereafter" — the property ADR-010 asks for — is a property of the pool rather than of a run. §6.2 gives the migration.

### 4.3 Decision F11 — browser-profile secrets are out-of-model **by construction** (N13)

This is where ADR-010 §6 requires OIKONOMOS to be stricter than Grok Bot, and it is warranted by the probe's own words: *"this is the hole in 'model never holds secrets'"* — cookie-persistence helper scripts exist on the box, the model can read files, and *"policy says don't scrape cookies to mint access — it is not a technical impossibility."*

> **N13 — Browser-profile and credential material is inaccessible to the model by construction, not by instruction.**

Three layers, in order of strength, because construction is the control and the others are backstops:

1. **Construction.** D3 lives on the `oikonomos-secrets` volume, mounted **only** into the browser/connector containers. It is not present in any filesystem namespace a model-driven process can see. A path that does not exist cannot be read by a determined agent, a jailbreak, or a bug.
2. **Enforcement.** The broker denies any tool call whose resolved target matches a D3 path pattern, regardless of tier, grant, or allow rule — the same fixed-floor treatment as §5.2, and for the same reason.
3. **Detection.** Every such denial emits an audit event of its own type. An attempt to read a cookie store is a signal worth keeping even when it fails.

**Liveness assertion:** a canary that *attempts* the read from inside the model's namespace and asserts both that it fails at layer 1 (path absent) and that layer 2 denies it when the path is synthesised. Asserting only that the compose file omits a mount tests the config, not the control.

---

## 5. The tier map, reworked

### 5.1 Decision F12 — keep the T0–T4 enum; change what a tier *implies*

ADR-010 §6 says T0–T2 collapse toward autonomous. The naive reading is to delete tiers. That would be wrong: `risk_tier` is a Postgres enum referenced by `capabilities`, `role_grants`, `approvals` and `audit_events`, ADR-003 fixed the resolution direction, and `resolveEffectiveTier`'s ceiling semantics ("a ceiling can only tighten") are correct and worth keeping. The tier is a good *risk statement*; it was only ever a bad *approval switch*.

So: **the tier stays, and stops implying approval.** A second, orthogonal output is introduced.

```
EnforcementClass = "autonomous" | "enforced"
```

`autonomous` → execute and audit. `enforced` → hard stop: park for approval, or hand to a human (takeover). The broker's `PreToolUse` hook remains the sole enforcement point (ADR-001); this changes what it decides, never where it decides it.

### 5.2 Decision F13 — the enforced floor is fixed and cannot be relaxed by any rule

Taken verbatim from ADR-010 §6. These four are `enforced` regardless of tier, grant, allow-rule, role, or configuration:

| # | Enforced action class | Handling |
|---|---|---|
| E1 | Spend / payment / purchase / transfer | Park for approval. Grok Bot's `request_virtual_card` equivalent — the probe's only unambiguous hard stop. |
| E2 | Auth/security friction: password, passkey, 2FA, CAPTCHA, SSO, identity check, "site requires a human" | **Human takeover.** Never typed by the model. Already CLAUDE.md non-negotiable #6; this is not new, it is now also mechanical. |
| E3 | Execution on the user's **local** machine | Ask every time, by default. Matches the probe's separate three-state local-execution policy (D). |
| E4 | Secret handling | Labelled secret-request; the value never enters the transcript and is never shown to the model (N4). |

Plus, from §4.3: **E5 — any access to a D3 path.**

> The floor is a floor. A `Require Approval` rule can add to the enforced set; nothing can subtract from it.

**Liveness assertion:** install a maximally permissive allow rule (`always allow *`) and assert that a payment action, a 2FA prompt, a local-execution request and a D3 path read each still stop. A test that only exercises the default configuration cannot tell a fixed floor from a default.

### 5.3 Decision F14 — the autonomous-by-default set

Also verbatim from ADR-010 §6: **send email, post publicly, delete/overwrite files on the shared environment, calendar/connector writes, routine creation, message one teammate.** These execute without a human card, and are audited.

This is the actual pivot, and it should be stated plainly rather than buried: under the old model a Tier-3 send parked; under the new one it sends. The probe justifies it — Grok Bot's own send/post/delete stops are *"behavioral, not a kernel deny"* — and the ADR owner has accepted that posture. The compensating controls are the audit trail (immutable, already built), refusal memory (per-run, already built), and the promotion mechanism below.

### 5.4 Decision F15 — `Require Approval` rules, and one total precedence order

```
require_approval_rules(
  rule_id uuid PRIMARY KEY, tenant_id text, role_id text NULL,  -- NULL = whole tenant
  capability_id text REFERENCES capabilities(capability_id),
  target_predicate jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true, created_by text, created_at timestamptz)
```

A matching rule promotes an otherwise-autonomous action to `enforced`. Per the probe (B): **Require Approval beats Always Allow.** OIKONOMOS makes the whole thing a single total order, evaluated top-down, first match wins — because "stacked gates, several of which are the model's own policy" is precisely the property that made Grok Bot's boundary unpredictable, and the fix is a decidable order:

| Rank | Input | Result |
|---|---|---|
| 1 | Broker unreachable / timeout / malformed / undescribable action / unknown capability | **enforced** (fail closed — unchanged, absolute) |
| 2 | Enforced floor E1–E5 (§5.2) | **enforced** |
| 3 | Matching `require_approval_rules` entry | **enforced** |
| 4 | Refusal memory: same (run, tool, target) already denied this run | **denied** (not re-parked — TASK-073, unchanged) |
| 5 | `role_grants` ceiling exceeded for the resolved tier | **enforced** |
| 6 | Otherwise | **autonomous** |

Rank 1 above rank 2 is deliberate: fail-closed outranks even the enumerated floor, so an unclassifiable action is never argued into rank 6 on the grounds that it did not match E1–E5.

Rank 4's placement is also deliberate and matches probe Q9: a denial is *"that attempt — not a permanent ACL,"* it does not become a grant when policy widens mid-run, and it does not re-ask. TASK-073's per-run/per-attempt semantics are correct as built and are **not** changed by this addendum.

### 5.5 What is deliberately *not* adopted from Grok Bot

- **A model-based reviewer.** The probe states Auto-review *"is model-based, not a parser."* OIKONOMOS's rank-2/3/5 checks are deterministic predicates over declared capabilities and manifests. A model deciding whether a model may act reintroduces the maker-checks-maker problem this project already rejects for its own reviews.
- **Rules that live on one desktop.** The probe notes personal Auto-review rules sync only to *that* install, and *"another install can miss them."* OIKONOMOS's rules are D0 rows — one tenant, one answer.
- **Advisory boundaries as a substitute for controls.** Covered by N12.

---

## 6. Migration path — reshape, do not rewrite

The governing constraint from ADR-010 §4: TASK-054, TASK-055 and TASK-083 are done and working, and connector work becomes *more* valuable under this model. The insight that makes a reshape sufficient:

> **Persistence belongs to the substrate, not to the harness object.** The harness may still be composed per run. What becomes durable is the state it points at.

Everything below follows from that one sentence, which is why no signature has to break.

### 6.1 `packages/harness-factory` — additive `environment` binding

`composeHarness` keeps its signature and every existing behaviour. `ComposeOptions` gains one optional field:

```ts
environment?: {
  workspaceRoot: string;      // "/oikonomos/workspace"
  roleId: string;             // the durable identity this run acts as
  roleDir: string;            // "/oikonomos/roles/<roleId>"
  sessionPool?: ConnectorSessionPool;   // §6.2
}
```

Omitting it yields exactly today's behaviour, so every existing test, canary and caller stays green. `mcpServers` continues to receive already-resolved strings and is still never read from env and never logged (N4/N9) — the pool resolves them, the contract is unchanged. Adding a field to a protected package is the whole change; the L1/L2/L3 layering, the `PreToolUse` seam and the fail-closed map are untouched.

### 6.2 `packages/connectors` — create/destroy becomes acquire/release

A `ConnectorSessionPool`, tenant-scoped and durable across runs: `acquire(connectorId)` returns a live session, minting one on first use and reusing it thereafter; `release()` returns it to the pool rather than tearing it down; a session that has expired is re-minted transparently. Existing manifest, enumeration, discovery-cache and `allowedTools` derivation code is untouched — the pool sits underneath them.

`services/worker`'s `ConnectorMount` interface keeps its shape; only its implementation stops destroying on run end.

### 6.3 `services/worker` — `executeTaskRun` keeps its contract

Three changes, all local:

1. Mount lifecycle acquires from the pool instead of creating (§6.2).
2. Serialization is re-keyed from ad-hoc agent identity to `role_id` — the durable identity is now the thing that must not run twice concurrently.
3. Routine firing (§3.4) becomes a source of queued tasks alongside intake.

TASK-076's four scheduler properties — per-role serialization, lanes, approval-aware idle, guarded priority interrupt with the user-lane protection — are **all still correct** and survive verbatim. The task is reshaped, not superseded (§7).

### 6.4 OpenSandbox (ADR-006) keeps its job

The Office is not a replacement for per-execution sandboxing. Tier-3/Tier-4 executions that warrant strong isolation still run in an OpenSandbox sandbox, launched *from* the Office, with the workspace mounted in and D3 emphatically not. ADR-006 is unaffected; TASK-027's deferred DOCKER-USER port-band closure gains urgency, because its stated trigger was "before the first real workload runs in a sandbox" and this addendum is what brings that date forward.

### 6.5 What is **not** migrated

`packages/broker`, `packages/policy`, `packages/approvals`, `packages/audit`, `packages/shared` keep their existing modules unchanged. §5 adds resolvers alongside; it removes nothing. The tier enum, the nonce lifecycle, the canonical-digest implementation and the immutable audit rules are all byte-identical after this addendum.

---

## 7. New invariants

| ID | Invariant | Source |
|---|---|---|
| N12 | A role's description is prompt material, never a control. No enforcement decision reads it. | probe Q6; §3.2 |
| N13 | Browser-profile and credential material is inaccessible to the model by construction, not by instruction. | ADR-010 §6; probe Q11; §4.3 |
| N14 | Every write declares a durability tier; state in D2 is assumed lost and may never inform a governance decision. | probe Q1; §2.2 |
| N15 | The enforced floor is a floor: rules may add to the enforced set, nothing may subtract from it. | ADR-010 §6; §5.2 |

N11 (Addendum E, "the sandbox is disposable, Postgres is durable") is reaffirmed and extended by D1.

---

## 8. Risk register

| ID | Risk | Control |
|---|---|---|
| R22 | Broadened autonomy causes a real, irreversible mistake that the old model would have parked | Enforced floor is fixed (N15); immutable audit on every autonomous action; per-role `Require Approval` rules available from day one; refusal memory unchanged |
| R23 | Durable shared state raises the blast radius of a leak — a credential in an audit payload is now discoverable by every role, indefinitely | Non-negotiable #4 unchanged; N13 removes the browser-cookie path Grok Bot leaves open; D3 mount exclusion is structural |
| R24 | Roles get mistaken for a security boundary as the roster grows | Stated in §2.1, §3.5 and §4.1; a role's grants, not its peers', decide every action; handoff carries no privilege |
| R25 | The environment becomes a pet — irreproducible state accumulates in D2 and a rebuild silently loses work | Durability canary (§2.2) asserts the D2 marker is *absent* after rebuild, making the loss loud rather than silent |
| R26 | Memory grows without bound and floods the prefix | Only `profile` tier is injected every turn; `note` carries a TTL; `log` is on demand (§3.3) |

---

## 9. Tickets

| ID | Title | Size | Depends on | Realised as |
|---|---|---|---|---|
| OIK-200 | Role identity, routines, messages and require-approval rules — schema + typed query layer | M | — | TASK-084 |
| OIK-201 | Three-scope / three-tier memory store with conflict order and ACL | M | — | TASK-085 |
| OIK-202 | `EnforcementClass` resolver + require-approval precedence (pure policy) | M | OIK-200 | TASK-086 |
| OIK-203 | Broker enforcement gate + fixed-floor liveness canary | M | OIK-202 | TASK-087 |
| OIK-204 | D3 sealed-secret path guard (N13 layers 2 and 3) | S | OIK-203 | TASK-088 |
| OIK-205 | The Office: durable environment compose + durability canary | M | — | TASK-089 |
| OIK-206 | `services/workspace`: path resolution, tier classification, handoff mailbox | M | OIK-200 | TASK-090 |
| OIK-207 | `composeHarness` environment binding (additive) | S | OIK-206, OIK-208 | TASK-091 |
| OIK-208 | Connector session pool: acquire/release | M | — | TASK-092 |
| OIK-209 | Worker scheduler re-keyed to `role_id` + routine firing | M | OIK-200 | TASK-076 (reshaped) |

---

## 10. Questions this addendum does **not** answer

Recorded so they are not mistaken for oversights:

1. **Multi-tenant.** One tenant exists (`basileia`) and N5 forbids a second kind. The schema carries `tenant_id` throughout, so a second tenant means a second environment, not a shared one — but the provisioning story for that is out of scope here.
2. **Which roles exist.** This addendum models roles; it does not name them. The initial roster is an owner decision.
3. **Local-machine execution transport.** E3 declares local execution enforced-by-default; the mechanism for reaching a local machine at all is not designed here and is not required by any ticket in §9.
4. **Evidence-store durability tier.** Treated as D0 alongside Postgres. If the evidence store is ever moved onto the Office volume, that is a material change and needs its own ADR.
