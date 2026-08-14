# ADR-001 — Broker enforcement point: PreToolUse hook, not canUseTool

**Status:** ACCEPTED · **Date:** 2026-08-13 · **Supersedes:** Synthesis Spec v0.1 §3, §5.2, §5.4; Gap Closure Plan v0.2 §P1
**Decision owner:** Alister Witbooi · **Verified against:** Claude Agent SDK permissions documentation, retrieved 2026-08-13

---

## Context

Both prior OIKONOMOS documents specified that the capability broker be wired to the Claude Agent SDK's `canUseTool` callback (or the `--permission-prompt-tool` CLI equivalent). The entire security model rests on one property:

> **P1 (invariant): every tool invocation an agent attempts is intercepted by the broker before execution.**

Verification against current SDK documentation shows `canUseTool` **does not satisfy P1.**

## Findings

The SDK evaluates a tool request through a fixed pipeline and stops at the first step that resolves it:

```
1. PreToolUse hooks        ← runs before every other step; deny applies even in bypassPermissions
2. Deny rules (disallowedTools)
3. Permission mode         ← dontAsk denies unapproved; plan blocks writes; bypassPermissions approves
4. Allow rules (allowedTools)  ← auto-approves; request never reaches step 5
5. canUseTool callback     ← last line of runtime defense; SKIPPED in dontAsk mode
```

Consequences that break the prior design:

- **F1.** A tool approved by an allow rule, `acceptEdits`, or `bypassPermissions` **never reaches `canUseTool`.** A single `allowedTools` entry — in a settings file, a subagent config, or a developer's local override — silently disables broker enforcement for that tool. The broker would not log a denial; it would log nothing at all.
- **F2.** Allow-rule coverage varies by form: a bare name (`Read`, `mcp__github__get_issue`) auto-approves *every* call to that tool; a scoped rule (`Bash(ls *)`) auto-approves only matches, with other calls falling through.
- **F3.** In `dontAsk` mode the `canUseTool` step is skipped entirely and unapproved tools are hard-denied.
- **F4.** Subagents under `bypassPermissions` inherit that mode and **cannot override it** — they may carry different system prompts and looser behaviour with full autonomous access.
- **F5.** Some calls reach `canUseTool` regardless of allow rules: `AskUserQuestion`, MCP tools flagged `_meta["anthropic/requiresUserInteraction"]`, and connector tools an organisation has set to ask.

## Decision

**The capability broker is implemented as a `PreToolUse` hook.** Defence in depth, four layers:

| Layer | Mechanism | Purpose |
|---|---|---|
| **L1 — Primary enforcement** | `PreToolUse` hook → broker HTTP endpoint | Satisfies P1. Runs before every other step; deny holds even under `bypassPermissions`. Every request audited here, allow or deny. |
| **L2 — Outer shell** | `permissionMode: "dontAsk"` + explicit `allowedTools` allowlist | Fixed, explicit tool surface. Anything unlisted is hard-denied rather than silently relying on a callback. |
| **L3 — Secondary runtime** | `canUseTool` callback → same broker endpoint (idempotent) | Catches the F5 class and provides a second decision point. Never the sole enforcement. |
| **L4 — Prohibitions** | `bypassPermissions` and `acceptEdits` **banned platform-wide**, including all subagents (F4). CI fails the build if either string appears in any harness invocation, settings file, or subagent definition. | Removes the modes that make L2/L3 bypassable. |

Additional binding rules:

- **R1.** `allowedTools` entries must be scoped form wherever the tool accepts arguments (F2). Bare-name entries require an ADR amendment naming the tool and justification.
- **R2.** The broker endpoint is idempotent per `toolUseID` — L1 and L3 hitting it for the same call produce one audit event and one decision.
- **R3.** Hook and callback both **fail closed.** Broker unreachable, timeout, or malformed response ⇒ deny. Timeout: 10 s for Tier 0–2; approval-pending responses return deny-with-message and park the run.
- **R4.** `PostToolUse` hooks write completion evidence (result digest, artifact URIs) to the audit trail — the post-condition half of the record.
- **R5.** Settings files, subagent definitions, and harness invocation flags are **protected paths** under CLAUDE.md; changes require review.

## Canary tests (CI-blocking, must exist before any capability work)

| ID | Test | Passes when |
|---|---|---|
| CAN-01 | Attempt a Tier-3 tool call with no approval | Denied; audit event written |
| CAN-02 | Add `allowedTools: ["mcp__gmail__send_message"]` (bare name) and retry CAN-01 | **Still denied by L1** — this is the test that would have caught the original design flaw |
| CAN-03 | Grep entire repo, settings, and subagent configs for `bypassPermissions` / `acceptEdits` | Zero occurrences |
| CAN-04 | Broker endpoint returns 500 / times out | Tool denied, run parked, no execution |
| CAN-05 | Spawn a subagent and attempt a Tier-3 call from it | Denied; audit attributes the subagent |
| CAN-06 | Replay a consumed approval nonce | Denied; `approvals.status='consumed'` unchanged |
| CAN-07 | Mutate payload after approval granted, then execute | Digest mismatch ⇒ `invalidated`; new approval required |
| CAN-08 | Same `toolUseID` hits broker via both L1 and L3 | One audit event, one decision (R2) |

## Consequences

- **Positive:** P1 becomes true and testable. CAN-02 is a regression test against the exact flaw the original design contained.
- **Cost:** hooks are process-level configuration, so every harness invocation path must be constructed by one shared factory — no ad-hoc `query()` calls. Enforced by lint rule and code review.
- **Risk retained:** this pins behaviour verified on 2026-08-13. The SDK evaluation order is a load-bearing external contract. **Action:** a scheduled monthly job re-reads the SDK permissions documentation and opens a ticket on any change to the pipeline order or hook semantics.

## References

- Claude Agent SDK — Configure permissions: https://code.claude.com/docs/en/agent-sdk/permissions
- Claude Agent SDK reference (Python): https://platform.claude.com/docs/en/agent-sdk/python
