# ADR-018 adversarial review — CX9, 2026-09

**Subject:** `docs/decisions/ADR-018-bot-templates.md` at commit `6f2c57e12627bd47b2c3579be3d87766699035e5`

**Reviewer:** CX9 / Codex (GPT), a non-Anthropic model and therefore independent of the Fable 5.1 author.

**Verdict:** **Accept-with-changes.** The internal-only, immutable-manifest direction is sound, but the two required changes below must be made before this ADR is accepted.

Evidence below was verified against the cited source at the subject commit; it is not inferred from the ADR's description of that source.

---

## Review questions

### Q1 — Can a manifest carry a credential outside the eight pattern families?

**Needs change.** `matchesSecretPattern` recognizes exactly eight regex families: provider-shaped keys, PEM, Telegram and assigned-secret syntax ([`packages/audit/src/redact.ts:14`](../../packages/audit/src/redact.ts#L14)-[`42`](../../packages/audit/src/redact.ts#L42)). It has no structural JWT detector, no URL-userinfo/query-token detector, and no entropy/encoding policy for arbitrary base64 blobs. The recursive walk only applies those same patterns to strings ([`redact.ts:48`](../../packages/audit/src/redact.ts#L48)-[`69`](../../packages/audit/src/redact.ts#L69)). Thus an otherwise valid bearer JWT, `https://user:token@example/`, or an opaque base64 credential can be exported unchanged.

The ADR's promise to refuse on *any* secret match is only as strong as that finite matcher, and the proposed template package would inherit this blind spot.

### Q2 — Is refusal bypassable by splitting a key across fields?

**Needs change.** The stipulated walk tests each string independently; it does not retain field boundaries or scan a canonical serialization. A credential divided between, for example, `identity.description` and a routine prompt will not form one regex match. Type-level exclusion of secret fields does not fix secret material in otherwise allowed prose fields ([`ADR-018:20`](ADR-018-bot-templates.md#L20)-[`28`](ADR-018-bot-templates.md#L28)).

### Q3 — Does install actually make zero grant writes?

**Unsound as written.** ADR-018 says installation creates a role through `POST /roles` and simultaneously requires a negative test proving zero grant-port calls ([`ADR-018:30`](ADR-018-bot-templates.md#L30)-[`34`](ADR-018-bot-templates.md#L34)). The current route unconditionally calls `deps.upsertRoleGrant` once for every `sdk:builtin` capability after role creation ([`services/control-api/src/app.ts:1086`](../../services/control-api/src/app.ts#L1086)-[`1105`](../../services/control-api/src/app.ts#L1105)). These are `role_grants` writes, regardless of whether the template supplied an integration grant. A spy on only a template-specific grant port would make the test pass while the database invariant fails.

The distinction is legitimate if the intended invariant is “no grants derived from the template,” but that is not the stated zero-write requirement and would need precise wording plus an observable test boundary.

## Required changes

1. Define and implement a template-specific credential policy beyond the current eight patterns: reject JWT-shaped strings, URLs containing userinfo or credential-bearing query keys, secret-like base64 blobs under an explicitly documented threshold/allowlist policy, and all `secret://` values. Add negative tests for every new structural class and for a split credential across two allowed manifest strings. If cross-field concatenation is intentionally not scanned, state the bounded threat model and prohibit split-capable paired fields by schema instead.
2. Resolve the grant contradiction. Either create installed roles through a no-default-grants factory and prove **zero `role_grants` writes** for the complete install transaction, or change the decision and spec to permit only the audited built-in floor. In the latter case, test the exact allowed built-in capability-id set and prove no template-derived `role_grants` write occurs; do not describe that as zero writes.

## Verdict rationale

The canonical digest, stored-manifest re-scan, private-only v1 boundary, paused routines and explicit memory opt-in are sound design choices. Acceptance is conditional on the two changes because the current wording would otherwise overclaim credential refusal and a no-grant installation property contradicted by the live role route.
