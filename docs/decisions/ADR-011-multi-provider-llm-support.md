# ADR-011 — Multi-provider LLM support, gemini-3.7-flash default

**Status:** ACCEPTED · **Date:** 2026-09-02 · **Decision owner:** Alister Witbooi
**Relates to:** ADR-001 (broker enforcement point), ADR-005 (control liveness), ADR-010 (persistent-office-computer pivot); `packages/harness-factory/src/ports.ts`; CLAUDE.md non-negotiables 1–3, Budget section

---

## 1. Context

Every OIKONOMOS run to date drives its agentic loop through the Claude Agent SDK, and `packages/harness-factory` is built directly against that SDK's vocabulary — not merely as a default, but structurally. `HarnessInvocation` (`packages/harness-factory/src/ports.ts`) types `hooks.PreToolUse`/`hooks.PostToolUse` as SDK hook matchers and `canUseTool` with the SDK's exact callback signature (`toolUseID`, `requestId`, `agentID`). `AgentSdkQueryFn` is injectable for tests, but the shape it's injected into assumes an SDK that has a native PreToolUse hook concept at all.

The owner now requires OIKONOMOS to run on multiple LLM providers, with **gemini-3.7-flash** (released 2026-08-13, Gemini 3 family's agentic workhorse) as the default going forward. Gemini's function-calling API has no equivalent of a PreToolUse hook: the model returns `functionCall` parts; the calling application's own code decides whether to execute each one and feeds a `functionResponse` back. There is no SDK-native interception point to bind a hook into — the interception point *is* whatever loop the caller writes.

This is not a drop-in swap. It is confirmed here, before any task is cut, that non-negotiable #1 — broker enforcement is the `PreToolUse` hook, never `canUseTool` alone — is a statement about *where in the decision path enforcement happens*, not about which SDK feature implements it. That distinction is what makes multi-provider support possible without weakening the non-negotiable.

## 2. Decision

**Multi-provider support is added at the harness-composition boundary, additively, with per-provider enforcement parity proven before a provider may execute tools.**

1. **The L1/L2/L3 ports (`PreToolUseHookPort`, `L2PolicyPort`, `CanUseToolPort`) become the provider-agnostic contract.** They are already plain async interfaces with no SDK-specific shape — this ADR does not change them. Every provider adapter, Claude or Gemini or future others, must call `l1.handle()` before executing any tool call it did not itself refuse, with no exceptions.
2. **A Gemini adapter is a new orchestration loop, not a `HarnessInvocation`-shaped object.** Because Gemini has no native hook, the adapter's own request/response loop *is* the interception point: on each `functionCall` the model emits, the adapter calls `l1.handle()` synchronously before ever executing the tool or returning a `functionResponse`. This is enforcement by construction (the adapter cannot reach the tool without going through the port), not enforcement by SDK feature — a stronger property than the hook mechanism gives Claude, not a weaker one, provided it is proven live.
3. **Enforcement parity must be proven with a liveness canary per ADR-005 before a provider is trusted with tool execution** — mirroring TASK-087's canary exactly: a test that removes or bypasses the adapter's `l1.handle()` call and asserts a previously-denied tool call now executes. No provider adapter merges without this. A provider without a passing canary is restricted to non-tool-executing runs only (see §3).
4. **gemini-3.7-flash becomes the default provider for new runs once its adapter passes its liveness canary.** Claude remains fully supported as the reference implementation and the fallback — this is additive per ADR-010's own "reshape, not rewrite" precedent, not a replacement. `ComposeOptions` gains an optional `provider` field (default `"gemini"`) following the exact additive pattern TASK-091 already established for `environment`: omitting it must not change any existing Claude-path test.
5. **Secrets:** a Gemini API key is a credential like the Telegram/Gmail secrets already handled this session — stored outside the repo (`C:\Users\User\.oikonomos\gemini.env` + a Windows User env var), never in a prompt, log, audit payload, or fixture (non-negotiable #4), and the repo's `hooks/secret-scan.js` still governs any attempted commit.

## 3. Interim scoping — what ships before full parity

Building a complete Gemini agentic adapter (subprocess/gate spawning, MCP wiring, tool decorators, the full run lifecycle) is real, multi-task work — not a config flag. Rather than block the default switch on all of it landing at once, provider support is staged:

- **Stage 1 (this wave):** Gemini adapter for **Tier-0 observation-only work** — no tool execution, read-only/summarization-shaped runs. This is the exact use case CLAUDE.md's Budget section already names ("Route Tier-0 observation work to cheap models via FreeLLMAPI") — multi-provider is the generalization of an idea this project already endorsed, to OIKONOMOS's own runtime rather than only DEVDEPARTMENT's build process. gemini-3.7-flash becomes the default **for Tier-0 work** in this stage.
- **Stage 2 (follow-on, not cut here):** the full tool-executing agentic adapter with a passing liveness canary, at which point gemini-3.7-flash can become the default for tool-executing runs too. Cutting Stage 2 tasks is explicitly deferred to a follow-up decompose pass once Stage 1 is live and reviewed — this ADR authorizes the direction, not a blank check to build the harder half unreviewed.

## 4. What does NOT change

- Broker enforcement stays the `PreToolUse`-hook-equivalent decision point for every provider (non-negotiable #1) — a provider adapter that cannot prove this via a liveness canary does not get tool execution, full stop.
- `bypassPermissions`/`acceptEdits` remain banned platform-wide, for every provider (non-negotiable #2).
- Fail-closed remains absolute: a Gemini adapter that cannot reach `l1.handle()` (timeout, malformed response, provider outage) denies, exactly like the existing ADR-001 map (non-negotiable #3).
- `packages/harness-factory` remains a protected path — a Gemini adapter change requires adversarial review by a different model than its author, same as every other protected-path task this project has shipped.
- Claude/the existing Claude Agent SDK harness is not removed, deprecated, or downgraded — it remains the reference implementation.

## 5. Consequences

- New package or module: a Gemini provider adapter (exact location decided at decompose time — likely `packages/harness-factory/src/providers/gemini.ts` or a sibling package, following whichever keeps `createHarness` free of hard-importing concrete adapters, per the existing composition-root discipline in `compose.ts`).
- `packages/policy`'s tier map / risk-tier assignment needs a provider dimension eventually (a Tier-0-only provider cannot be handed a Tier-3 action) — in scope for the decompose, not decided here.
- Budget tracking (CLAUDE.md's R30,000/month ceiling, per-routine budgets from week 5) needs a per-provider cost table — gemini-3.7-flash's pricing ($0.75/1M input, $3.75/1M output at introductory pricing) differs materially from Claude's, and Stage 1's whole rationale is cost-driven, so this must land alongside Stage 1, not after.
- `ComposeOptions.provider` is additive per §2.4 — the existing Claude-only test suite must pass with zero modifications when it's omitted, matching TASK-091's own acceptance bar.

## 6. Rollout

1. This ADR (accepted, this document).
2. Decompose Stage 1 into concrete tasks (this session, ORCH, interactive — not deferred to a separate headless pass given real-time human availability for correction).
3. Dispatch and build Stage 1 under the normal DEVDEPARTMENT protected-path review standard.
4. A follow-up decompose pass cuts Stage 2 (full tool-executing parity) once Stage 1 is live and reviewed.
