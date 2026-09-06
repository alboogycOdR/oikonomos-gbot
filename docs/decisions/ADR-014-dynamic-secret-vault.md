# ADR-014 — A dynamic secret vault for chat-requested secrets, distinct from D3/OpenBao

**Status:** Accepted (2026-09-06, after adversarial review by Fable 5.1 — accept-with-changes, six changes applied below; see the appended review section for the full verdict)
**Date:** 2026-09-06
**Author:** ORCH (Claude Sonnet 5); reviewed by Fable 5.1 (different model, per this project's architectural-review discipline)
**Related:** ADR-004 (action_render must be derived, never caller-supplied); ADR-005 (control liveness — see the side finding on TASK-067 in the review section); ADR-006 Addendum B (OpenSandbox Credential Vault / OIK-045a — this vault is its system of record, §1); OIK-120 (age + systemd credentials — the operator-side story for provisioning `OIK_SECRET_VAULT_KEY`); CLAUDE.md non-negotiable #4 (no credentials in prompts/logs/audit/fixtures); TASK-088/093/097 (D3 sealed-secret path guard); TASK-184 (G-05a, blocked three times — this ADR resolves its third block); TASK-190/191 (404-never-403 discipline, reused here); specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-05

---

## Context

TASK-184 (`request_secret` broker tool) was blocked three times. The first two were real but narrow integration gaps, fixed by widening its `Owned_Paths` (worker-side tool mounting, capability admission). The third block is different in kind: CX found, correctly, that **no dynamic secret-storage mechanism exists anywhere in this codebase.**

I independently traced this myself before drafting this ADR:

- `packages/shared/src/sealedSecretRoot.ts` exports exactly one thing: `SEALED_SECRET_ROOT = "/oikonomos/secrets"`, a filesystem path constant.
- `packages/broker/src/secretPathGuard.ts` (D3) only ever **denies** a tool from targeting that path. It is a negative control — "no tool may read or write here" — not a place anything is actually written.
- The only working `secret://` convention in the repo (`packages/sandbox-client/src/secretResolver.ts`) resolves a ref to a **static, operator-provisioned environment variable** (`OIK_SECRET_<REF>`), set once at deploy time. It has no notion of a value created dynamically, at runtime, by a human filling in a chat-triggered form.
- CLAUDE.md's own stated Phase-0 posture — "systemd credentials + age-encrypted secrets file" — describes the same static, deploy-time model. It was never meant to cover a bot asking a human for a fresh secret mid-conversation; that capability (G-05) didn't exist in any spec until this session's Grok Bot parity disposition.

TASK-184's Description silently assumed a vault existed under D3 and only needed a resolver bolted on. It doesn't. Building one is a real, standalone data-model and security decision — not something a builder should improvise mid-task, and not something I should improvise inside a fourth incremental territory widen either.

**A second thing I traced while here, which turned out not to be a real gap:** CX's block also named a missing "TASK-067 approval-card renderer" in `packages/approvals/**`. I read both candidate mechanisms directly:

- `packages/broker/src/describe.ts` (TASK-067's own describe-or-deny mechanism) is real but its own doc comment says it, plainly: *"`index.ts` is outside Owned_Paths so this module is not wired into the HTTP handler in this task."* It is dead code, never connected to the live `handlePreToolUse` path.
- The actual, live, ADR-004-**Accepted** mechanism (`packages/approvals/src/render.ts`'s `actionRender`) is fully generic — it derives a render from any `{toolName, input, destination}` triple, with no per-tool registration required. `request_secret` will get a real, working approval card the moment `issueApproval` is called with sensible `input`/`destination` fields — **no new `packages/approvals` code is required** for a functioning (if generic-formatted) card.

So the render half of TASK-184's block resolves to "use the mechanism that's actually wired in," not "build a missing subsystem." Only the vault is real, new work.

## Decision

### 1. A new, purpose-built dynamic secret vault — not a reuse of D3/SEALED_SECRET_ROOT

D3 stays exactly what it is: a filesystem-path deny-list reserved for the **future** OpenBao-managed browser-session OAuth leases (ADR-006 Addendum B). Overloading it for chat-requested API keys would blur two genuinely different threat models (a leased, short-lived browser session credential vs. an operator-fulfilled, long-lived-until-revoked API key) under one name. The new mechanism gets its own, clearly distinct name: `packages/db/src/secretVault.ts`.

**This vault is the system of record; OIK-045a (the OpenSandbox Credential Vault, pulled into the foundation by ADR-006 Addendum B) is the injection path once TASK-170 lands.** `resolveSecretValue`'s only legitimate callers are host-side connector session minters and the future OIK-045a injector that places a credential into an outbound request header/body — **never code running inside a sandbox**, and never a direct model-visible tool result beyond the opaque `secret://<ref>`. This split must be preserved by every future caller: the vault decrypts on the host; the sandbox only ever sees the effect of an already-authenticated outbound call, matching ADR-006 B's own "never readable from inside the sandbox" guarantee.

### 2. Storage: envelope-encrypted rows in Postgres, not a new file-based store

Given this project's stated minimal-infrastructure discipline (no OpenBao until Phase 3, no new external services introduced casually) and that `packages/db` already exists as the single typed-storage layer for everything else this session has built (skills, threads, routines), the pragmatic, in-convention choice is a new table, not a new filesystem convention:

```sql
CREATE TABLE secret_values (
  ref uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  role_id text NOT NULL REFERENCES roles(role_id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

`key_version` costs nothing now and turns a future key rotation into a data migration (re-encrypt rows under the new key, bump the column) instead of a schema change made under pressure. It is also bound into the AAD (§3) so a row can never be decrypted under the wrong key version by mistake.

This is a **separate table from `secret_requests`**, deliberately. `secret_requests` (label, purpose, status, timestamps) is the kind of row that will legitimately flow through ordinary list/detail API responses for a human reviewing pending requests — it must be structurally incapable of accidentally carrying ciphertext via a careless `SELECT *`. `secret_values` has no route that lists or serializes it; the only two operations against it are "insert one row at fulfilment" and "decrypt-and-return-to-a-connector-minter by (ref, role_id)."

### 3. Encryption: WebCrypto AES-256-GCM with row-binding AAD, key resolved through the existing `secret://` convention — not a new KMS, not a `CONTROL_API_TOKEN` analogy

- **Key resolution reuses the existing convention, it does not invent a new one.** The vault key is itself a `secret://` ref — `secret://vault/key` — resolved through the same `envSecretResolver` this codebase already uses for every other operator-provisioned credential (`packages/sandbox-client/src/secretResolver.ts` / `packages/connectors`'s equivalent), which derives `OIK_SECRET_VAULT_KEY` from it exactly the way `OPENSANDBOX_API_KEY_REF` derives `OIK_SECRET_OPENSANDBOX_API_KEY`. **This is not a `CONTROL_API_TOKEN` analogy** — `CONTROL_API_TOKEN` barely appears in `src/` and is the wrong precedent to cite. The real precedent, and the one an implementer should actually go read, is the resolver convention. OIK-120 (age-encrypted secrets + systemd credentials) is the operator-side story for how `OIK_SECRET_VAULT_KEY` itself gets onto the machine — this ADR does not need to re-derive that, only consume it through the resolver like everything else does.
- **Use WebCrypto (`globalThis.crypto.subtle`), not Node's `createCipheriv`/`getAuthTag`.** `subtle.encrypt({name: "AES-GCM", iv, additionalData}, key, plaintext)` returns one buffer already shaped `ciphertext‖tag` — store that whole buffer as `ciphertext bytea`, plus a fresh random 12-byte value as `nonce bytea` (AES-GCM requires nonce uniqueness per key; never reuse one). State this exact layout in `secretVault.ts`'s own header comment so a future reader never has to reverse-engineer it from the code.
- **Bind the row into the ciphertext itself, via AAD** — this is the highest-value change in the whole review, and it's about three lines: `additionalData = new TextEncoder().encode(canonicalJson({ref, tenant_id, role_id, key_version}))`, supplied to both `encrypt` and `decrypt`. A ciphertext blob moved (by a bug, a bad migration, an operator mistake) into a *different* row then fails GCM authentication and decrypts to nothing, regardless of what the `WHERE` clause would have allowed — role/tenant binding becomes a property the *cryptography* enforces, not only the SQL filter. `resolveSecretValue` must reconstruct the identical AAD from the row it fetched (including `key_version`) before calling `decrypt`; a mismatch (tampering, a moved blob, or the wrong key version) throws, caught and mapped to the same opaque not-found error as a missing row (§4) — but the two cases should be **distinguishable in an internal log**, even though identical to the caller.
- **Construction-time key validation, not import-time.** `secretVault.ts` exports a factory, `createSecretVault(options: {resolveKey: () => Promise<Buffer>})`, which validates the resolved key's length once at construction and throws immediately if it's missing or the wrong size — never a bare module-level `throw` at import. `services/control-api` and `services/worker` call this factory once at process startup (each service's own entry point, not inside a request handler) and let a construction failure crash the process before it accepts any work — this is where "fail closed, don't defer to first use" (CLAUDE.md non-negotiable #3) actually belongs; see the Q6 correction below for why the ADR's original import-time-throw framing was wrong.
- Key rotation beyond `key_version`'s bookkeeping (§2) is out of scope for v1 — an acceptable gap for a net-new, non-urgent feature, not a regression.

### 4. The resolver refuses cross-role resolution by construction, not by a post-hoc check

```typescript
export async function resolveSecretValue(
  options: DatabaseOptions,
  ref: string,
  requestingRoleId: string,
): Promise<string> // throws, never returns undefined/null for "wrong role" vs "missing" —
                    // both must look identical to the caller, same 404-never-403 discipline
                    // TASK-190/191 already established for HTTP routes.
```

The SQL `WHERE` clause itself filters on `ref = $1 AND role_id = $2 AND tenant_id = $3` — a row that exists but belongs to another role (or tenant) produces zero results, identical to a genuinely nonexistent ref. The `tenant_id` filter is redundant given `role_id` is already globally unique across tenants, but it's added anyway to match the TASK-190/191 pattern exactly (every ownership check in this codebase filters on the same fields, not a subset chosen per-table). This mirrors the `404-never-403` principle those tasks established: never let a caller distinguish "doesn't exist" from "exists but isn't yours." Verified during review: `ref` is a random UUID primary key with no sequential or guessable structure, so existence-probing by ref enumeration is infeasible independent of this discipline — the 404-never-403 property is defense in depth here, not the only thing standing between an attacker and a real answer.

Confirmed during review: ownership is filtered in the `WHERE` before any decryption runs, so the two paths that return "not found" (missing row; wrong role/tenant) never reach GCM at all — there is no timing surface from the crypto on those paths. The third path — a real, correctly-owned row whose AAD or auth tag fails to verify (corruption, tampering, or a `key_version` mismatch) — must map to the *same* opaque error the caller sees, per §3's AAD discussion above.

### 5. Only the fulfilment code path ever holds a plaintext value in memory

`request_secret`'s tool handler never sees the value — it only creates the `secret_requests` row and parks. The **only** code that ever holds plaintext is the fulfilment handler (TASK-187's real API+UI form): it receives the human-typed value, calls `secretVault.store(...)` (encrypts immediately), writes only the resulting `secret://<ref>` into `secret_requests.secret_ref`, and the value itself is never logged, never placed in an audit payload, never returned in any HTTP response body after the initial write.

**Two dedicated audit event types, distinct from `secret_requests.created`/`fulfilled`:** `secret_vault.write {ref, role_id}` (emitted by `storeSecret`, at fulfilment) and `secret_vault.read {ref, role_id, run_id}` (emitted by `resolveSecretValue`, on every successful decrypt). Without this, a security review can see that a request existed but has no way to tell "the ciphertext was actually decrypted for use" from "it sat there, never consumed" — the decrypt is the sensitive event, and today nothing makes it visible. Neither event payload carries the plaintext value; both carry only the opaque `ref` and the acting `role_id`/`run_id`.

### 6. The approval card: use the generic, already-wired renderer for v1; a nicer one is a small, separately-scoped follow-up

Ship `request_secret`'s approval by calling the real, live `issueApproval` (packages/approvals, already ADR-004-Accepted and wired) with `input: {label, purpose}` and a sensible `destination` (e.g. the label itself). The card will render generically (`destination: / toolName: / input: / bound:` block), not the prettier "Bot `<name>` is asking for: `<label>` — `<purpose>`" sentence the original spec envisioned. Producing that exact sentence would require a small, *still fully derived* (ADR-004-compliant — computed by trusted code from the payload, never caller-supplied prose) per-toolName special case inside `packages/approvals/src/render.ts`'s `actionRender`. That is real but small (a few lines, one `if (action.toolName === "request_secret")` branch) — worth doing for real UX quality, but it is optional for a correct v1 and touches a file outside TASK-184's current territory, so it should be an explicit, separately-reviewed one-line `Owned_Paths` addition if the implementer chooses to include it, not silently bundled in.

## Consequences

- TASK-184 gains a real, buildable path forward: it no longer needs to invent vault semantics mid-task, and its "missing renderer" fear is resolved (use what's already live).
- A new task is needed for the vault itself before TASK-184 can proceed — see PLAN.md TASK-192.
- This is genuinely net-new infrastructure (one migration, one small crypto module) but adds zero new external dependencies or services, matching this project's stated minimal-infrastructure discipline.
- Key management beyond `key_version`'s bookkeeping (a single long-lived symmetric key, no rotation *mechanism* — only the schema hook for one) is a real, documented v1 limitation. If `request_secret` sees real production use before OpenBao (Phase 3) arrives, rotation becomes a legitimate fast-follow; it is not blocking for a first, low-volume, net-new feature.
- A separate, real finding surfaced during review, unrelated to this vault: `packages/broker/src/describe.ts` (TASK-067's describe-or-deny mechanism) is dead code — imported by nothing, never wired into `handlePreToolUse`. Its "undescribable ⇒ deny" control is therefore **configured but inert**, an ADR-005 liveness failure in its own right. This is not this ADR's problem to fix, but it must be logged as its own task (see PLAN.md) rather than left to be rediscovered.

## Resolution — all six required changes applied 2026-09-06

Every open question below was resolved by the Fable 5.1 review appended after this line, and the answer has been folded into §1–§6 above (not left as a dangling question):

1. ~~Is GCM's auth tag appended or a separate column?~~ **Resolved (§3):** WebCrypto's `subtle.encrypt` emits `ciphertext‖tag` as one buffer — store that whole buffer, plus a separate `nonce` column.
2. ~~Hard crash vs. lazy first-use on a missing key?~~ **Resolved (§3):** neither, exactly — a **factory** (`createSecretVault`) validates at construction time; the calling service crashes at its own startup, not at import time and not deferred to first use.
3. ~~Dedicated audit event types?~~ **Resolved (§5):** yes — `secret_vault.write` and `secret_vault.read`, added.

Additionally: the key is resolved through the existing `secret://`/`envSecretResolver` convention rather than a bespoke `CONTROL_API_TOKEN`-style variable (§3); the row is now cryptographically bound to `{ref, tenant_id, role_id, key_version}` via AAD, not just SQL-filtered (§3); `tenant_id` was added to the resolver's `WHERE` to match the TASK-190/191 pattern exactly (§4); and OIK-045a's role as the vault's sandbox-facing consumer is now stated explicitly (§1).

---

## Adversarial review — 2026-09-06, Fable 5.1 (different model from the Sonnet 5 author)

**Verdict: ACCEPT-WITH-CHANGES.** Apply the six changes below, then mark Accepted. TASK-184 may proceed as scoped once TASK-192 lands with changes 3–5.

### Verified, not taken on trust

- **Renderer finding is correct.** `packages/broker/src/describe.ts` is imported by nothing in `packages/broker/src/index.ts` or any service — dead code, as its own doc comment says. `packages/approvals/src/render.ts` `actionRender` is live (imported by `issue.ts` and `editApproval.ts`) and generic over `{toolName, input, destination}`. No new approvals code is needed for a working card. *Separate finding to log as its own task:* TASK-067's "undescribable ⇒ deny" control is therefore configured-but-inert — an ADR-005 liveness failure, not ADR-014's problem.
- **The storage gap is real.** `secretResolver.ts` (sandbox-client) and `envSecretResolver.ts` (connectors) only map refs to `OIK_SECRET_*` env; `secretPathGuard.ts` is deny-only; nothing stores anything.

### Q1 Storage level — right level, wrong framing
Postgres + AES-256-GCM with no new service is the correct Phase-0 answer; a file/age scheme from Node would be a second convention and harder to test. Two framing defects:
1. **OIK-045a is missing.** ADR-006 Addendum B pulls the OpenSandbox Credential Vault into the foundation ("secrets injected into sandbox outbound requests, never readable from inside the sandbox"). That is the intended *consumer* of these values once TASK-170 lands. The ADR must state: **this vault is the system of record; OIK-045a is the injection path; `resolveSecretValue`'s only callers are host-side connector minters and the 045a injector — never code running inside a sandbox.**
2. **Drop the `CONTROL_API_TOKEN` analogy** (it barely exists in `src/`). The real precedent is the existing `OIK_SECRET_*` resolver convention. Resolve the vault key as `secret://vault/key` → `OIK_SECRET_VAULT_KEY` through the existing `envSecretResolver`, and cite OIK-120 (age/systemd secrets) as the operator-side store for it.

### Q2 404-never-403 vs GCM timing — sound
Ownership is filtered in the `WHERE` before any crypto runs, so "wrong role" and "missing" both yield zero rows and never reach decrypt; there is no GCM timing surface on those paths. The third path (real row, auth-tag failure = corruption/tamper) must map to the *same* opaque caller error, with the distinction logged internally. `ref` is a random uuid PK, so existence probing is infeasible. Add `tenant_id = $3` to the `WHERE` — redundant given role_id is globally unique, but it matches the TASK-190/191 pattern.

### Q3 Key rotation — acceptable v1 gap, not gating
Add `key_version smallint NOT NULL DEFAULT 1` to `secret_values` now; it is free and makes future rotation a data migration instead of schema+data. Open Question 2 (hard fail on unset key): yes — see change 5 for where.

### Q5 Byte layout — decided
Use **WebCrypto (`globalThis.crypto.subtle`, native in Node 22)**, not `createCipheriv`/`getAuthTag`. `subtle.encrypt` AES-GCM emits `ciphertext‖tag` as one buffer: store that as `ciphertext bytea`, plus a 12-byte random `nonce bytea`. State this in `secretVault.ts`'s header. **Bind the row into the ciphertext:** `additionalData = canonicalJson({ref, tenant_id, role_id, key_version})`. A DB-level move of a blob into another role's row then fails authentication — role binding enforced by the crypto, not only by the `WHERE`. Highest-value change in this review; ~3 lines.

### Q6 Contradictions / missing references
- **TASK-192 AC5 contradicts this ADR's own Open Question 2.** "Import of `secretVault.ts` throws if the key is unset" makes `packages/db` unimportable in any process without the key (every control-api route, every db test). Change to a factory `createSecretVault({ resolveKey })` that validates key length at construction; `services/control-api` and `services/worker` construct it at startup and crash there. Send to CX9 before it builds import-time throwing.
- **NN#4 in tests:** the test key must be generated at test time (`crypto.getRandomValues`), never a base64 literal in a fixture.
- **Open Question 3: yes.** Add `secret_vault.write {ref, role_id}` and `secret_vault.read {ref, role_id, run_id}` audit events; the decrypt is the sensitive event and is otherwise invisible.
- ADR-004, ADR-010 N13, ADR-006 B: no contradictions found.

### Required changes
1. §Related/§1 — OIK-045a split statement (system of record vs injection path; no sandbox-side resolver calls).
2. §3 — key via `secret://vault/key` + existing `envSecretResolver`; cite OIK-120; drop `CONTROL_API_TOKEN`.
3. §2 — add `key_version smallint NOT NULL DEFAULT 1`.
4. §3 — WebCrypto AES-GCM, `ciphertext‖tag`, 12-byte nonce, AAD `{ref, tenant_id, role_id, key_version}`; TASK-192 gains a tamper test (swap two rows' ciphertext → both fail to decrypt).
5. §3 / Open Q2 — factory with construction-time key validation; services crash at startup. **Patch TASK-192 AC5.**
6. Open Q3 — add the two audit event types; the resolver emits `secret_vault.read`.
