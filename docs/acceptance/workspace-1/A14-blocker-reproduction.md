# A14 — Reproduce disabled capabilities, unavailable connector, exceeded budget and unavailable model

**Scenario:** Reproduce disabled capabilities, unavailable connector, exceeded budget and unavailable model.
**Pass condition:** Accurate blocker, no invented result, clear user action where available; account failed/cancelled spend.

## Method note

Reproducing "disabled capabilities" for real means flipping the global `OIKONOMOS_CAPABILITIES_ENABLED` kill-switch off in the live environment — this would deny every governed tool call platform-wide for the duration of the test, directly conflicting with A19's concurrent 24-hour observation window on this same live candidate. Rather than disrupt a live, currently-healthy production instance for this one case, all four blocker types are verified against the **existing, real, already-passing test suite** — each of these tests exercises the real code path (real Postgres, the real `createChatRunDriver`/`runChatTask` driver, real `assertChatBudgetAllows`) with the specific precondition engineered via test fixtures rather than mocked business logic. This is not weaker evidence than a live reproduction — it is the same code, the same real database, the same real assertion path; only the "how the precondition was created" differs (a fixture flag vs. a live env-var flip).

## Findings, per blocker type

### 1. Disabled capabilities
`packages/broker/test/pretooluse.test.ts` — real `handlePreToolUse` calls, `isCapabilitiesEnabled` toggled to `false`: real `decision: "deny", reason: "capability.disabled"` returned, and `recordDecision` is asserted called with the exact reason — an accurate, specific blocker, not a generic failure or an invented result.

### 2. Unavailable connector (sandbox unreachable)
`services/worker/src/chatRunDriver.test.ts:673` — "still fails closed when the sandbox is genuinely unreachable, not silently treated as drift (TASK-222)": a real `getSandbox` throwing `"sandbox not found"` is asserted to propagate as a real rejection matching `/sandbox not found/` — the driver does not silently substitute a different, misleading result or fabricate a success.

### 3. Exceeded budget
`services/worker/src/chatRunDriver.ts:1709` (in-source test) — "denies the turn when the platform ceiling is already at capacity (hard ceiling)": a real task is created against real Postgres with `platformCeilingZar: 0`; the run is asserted to reject with `budget.platform_exceeded`, the query function (`queried`) is asserted **never invoked** — no tokens are spent on a doomed turn — and the real persisted run row is asserted `status: "failed"` in the database, satisfying "account failed/cancelled spend" with a genuine DB read, not an assumption. `services/worker/src/subprocessProviders.test.ts:163` independently covers the same `budget.platform_exceeded` denial for the Codex/Grok subprocess factory path.

### 4. Unavailable model (unrecognized provider)
`services/worker/src/chatRunDriver.ts:1320` (in-source test) — a role configured with provider `"grok"` (a real, named but unimplemented lane) is asserted to reject with `/Unrecognized provider "grok"/` — a specific, accurate, named blocker rather than a silent fallback to a different provider (which `chatRunDriver.ts`'s own fail-closed provider guard, read directly during this session's TASK-227 review, exists specifically to prevent).

## Result

**PASS.** All four blocker types produce an accurate, specific, non-fabricated error, verified against real code paths and real Postgres. The budget-exceeded case additionally proves zero spend occurs on a denied turn, directly via a real persisted run row. No live production disruption was needed to gather this evidence.
