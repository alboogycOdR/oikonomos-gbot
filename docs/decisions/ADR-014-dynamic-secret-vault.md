# ADR-014 — A dynamic secret vault for chat-requested secrets, distinct from D3/OpenBao

**Status:** Proposed (drafted by ORCH on Sonnet 5 at the user's request, 2026-09-06 — this is a first design pass, not a Fable/Opus-reviewed decision; recommend an opus-5 adversarial pass before treating it as Accepted, matching this project's own stated discipline for architectural work)
**Date:** 2026-09-06
**Author:** ORCH (Claude Sonnet 5)
**Related:** ADR-004 (action_render must be derived, never caller-supplied); ADR-006 Addendum B (OpenSandbox Credential Vault, OpenBao narrowed to browser-session OAuth leases); CLAUDE.md non-negotiable #4 (no credentials in prompts/logs/audit/fixtures); TASK-088/093/097 (D3 sealed-secret path guard); TASK-184 (G-05a, blocked three times — this ADR resolves its third block); specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-05

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

### 2. Storage: envelope-encrypted rows in Postgres, not a new file-based store

Given this project's stated minimal-infrastructure discipline (no OpenBao until Phase 3, no new external services introduced casually) and that `packages/db` already exists as the single typed-storage layer for everything else this session has built (skills, threads, routines), the pragmatic, in-convention choice is a new table, not a new filesystem convention:

```sql
CREATE TABLE secret_values (
  ref uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  role_id text NOT NULL REFERENCES roles(role_id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

This is a **separate table from `secret_requests`**, deliberately. `secret_requests` (label, purpose, status, timestamps) is the kind of row that will legitimately flow through ordinary list/detail API responses for a human reviewing pending requests — it must be structurally incapable of accidentally carrying ciphertext via a careless `SELECT *`. `secret_values` has no route that lists or serializes it; the only two operations against it are "insert one row at fulfilment" and "decrypt-and-return-to-a-connector-minter by (ref, role_id)."

### 3. Encryption: AES-256-GCM, key from a persisted environment variable — matching the `CONTROL_API_TOKEN` pattern, not a new KMS

- A single symmetric key, `OIK_SECRET_VAULT_KEY` (32 raw bytes, base64-encoded), generated once (`openssl rand -base64 32`) and persisted as a machine-level environment variable exactly the way `CONTROL_API_TOKEN` already is — no new secrets-management infrastructure, no OpenBao, no age binary invocation from Node. This is genuinely Phase-0-compliant: it *is* a systemd-credential-shaped mechanism, just protecting a second-order secret instead of a first-order one.
- Each value is encrypted with a fresh random 12-byte nonce (AES-GCM requires nonce uniqueness per key; never reuse). Store `ciphertext` and `nonce` together; GCM's authentication tag can be appended to `ciphertext` (Node's `crypto` API does this by default when you call `cipher.getAuthTag()` and concatenate, or store it as a third column if that's cleaner against this codebase's existing bytea conventions — implementer's call, document whichever is chosen).
- Key rotation is out of scope for v1 (documented as a known limitation, matching how `CONTROL_API_TOKEN` itself has no rotation story yet either) — this is an acceptable v1 gap for a net-new, non-urgent feature, not a regression.

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

The SQL `WHERE` clause itself filters on `ref = $1 AND role_id = $2` — a row that exists but belongs to another role produces zero results, identical to a genuinely nonexistent ref. This mirrors the `404-never-403` principle this session already applied to `GET/PATCH /skills/:id` and `/threads/:id/*` (TASK-190/191): never let a caller distinguish "doesn't exist" from "exists but isn't yours."

### 5. Only the fulfilment code path ever holds a plaintext value in memory

`request_secret`'s tool handler never sees the value — it only creates the `secret_requests` row and parks. The **only** code that ever holds plaintext is the fulfilment handler (TASK-187's real API+UI form): it receives the human-typed value, calls `secretVault.store(...)` (encrypts immediately), writes only the resulting `secret://<ref>` into `secret_requests.secret_ref`, and the value itself is never logged, never placed in an audit payload, never returned in any HTTP response body after the initial write.

### 6. The approval card: use the generic, already-wired renderer for v1; a nicer one is a small, separately-scoped follow-up

Ship `request_secret`'s approval by calling the real, live `issueApproval` (packages/approvals, already ADR-004-Accepted and wired) with `input: {label, purpose}` and a sensible `destination` (e.g. the label itself). The card will render generically (`destination: / toolName: / input: / bound:` block), not the prettier "Bot `<name>` is asking for: `<label>` — `<purpose>`" sentence the original spec envisioned. Producing that exact sentence would require a small, *still fully derived* (ADR-004-compliant — computed by trusted code from the payload, never caller-supplied prose) per-toolName special case inside `packages/approvals/src/render.ts`'s `actionRender`. That is real but small (a few lines, one `if (action.toolName === "request_secret")` branch) — worth doing for real UX quality, but it is optional for a correct v1 and touches a file outside TASK-184's current territory, so it should be an explicit, separately-reviewed one-line `Owned_Paths` addition if the implementer chooses to include it, not silently bundled in.

## Consequences

- TASK-184 gains a real, buildable path forward: it no longer needs to invent vault semantics mid-task, and its "missing renderer" fear is resolved (use what's already live).
- A new task is needed for the vault itself before TASK-184 can proceed — see PLAN.md TASK-192.
- This is genuinely net-new infrastructure (one migration, one small crypto module) but adds zero new external dependencies or services, matching this project's stated minimal-infrastructure discipline.
- Key management (a single long-lived symmetric key, no rotation story) is a real, documented v1 limitation. If `request_secret` sees real production use before OpenBao (Phase 3) arrives, rotation becomes a legitimate fast-follow; it is not blocking for a first, low-volume, net-new feature.

## Open questions for a real adversarial (opus-5 or Fable) pass before this is Accepted

1. Is GCM's auth tag stored appended to `ciphertext` or as a separate column? Either is fine cryptographically; pick one and make `secretVault.ts`'s own doc comment state it plainly so a future reader doesn't have to reverse-engineer the byte layout.
2. Should `OIK_SECRET_VAULT_KEY`'s absence at process start be a hard crash (fail closed, matching this project's other non-negotiables) rather than a lazy first-use error? Recommend: hard crash at `services/control-api`/`services/worker` startup if `request_secret`'s capability is enabled but the key is unset — do not let a misconfigured deployment silently accept requests it can never fulfil correctly.
3. Does this need its own audit-event types (`secret_vault.write`, `secret_vault.read`) distinct from `secret_requests.created`/`fulfilled`, so a security review can distinguish "a request was made" from "the ciphertext was actually decrypted for use" (e.g. inside a connector minter)? Leaning yes, but not drafted here.
